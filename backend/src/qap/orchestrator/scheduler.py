"""任务调度器：DAG 步骤的并行调度（容量租约 + 全局并行上限 + 步骤超时）。

调度模型（契约 §3 scheduler 节）：
- ``max_parallel_steps``：**平台全局**同时运行的步数上限（跨任务共享，
  以内部计数器实现，避免 asyncio.Semaphore 无法非阻塞试探的问题）；
- 每步执行前必须先取得硬件租约（Allocator，容量约束），kind → 节点类型
  映射固定：classical→cpu、quantum→qpu、agent→gpu；
- ``step_timeout_seconds``：单步超时 → 该步 failed（错误消息注明超时），
  下游级联 cancelled，独立分支继续；
- ``retry_failed_steps``：true 时每步失败后重试一次（原型默认 false）。

可观察性：每次状态迁移发布 ``task.updated``（全量 Task，契约 §7）；
任务终态触发 ``on_task_finished`` 回调（租户配额释放等，由组装层注入）。

事件驱动 + 轮询兜底：步骤完成/失败会 set 一个 wake 事件立刻唤醒编排循环；
容量等待等纯外部事件由 ``poll_interval`` 轮询兜底（缺省 50ms）。
"""

from __future__ import annotations

import asyncio
from time import perf_counter
from typing import Awaitable, Callable

from qap.core.clock import utcnow_iso_ms
from qap.core.errors import SchedulingError
from qap.domain.models import Step, Task
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.orchestrator.dag import validate_dag
from qap.orchestrator.runners import simulate_step
from qap.orchestrator.step_context import running_task_scope

#: Step.kind → 硬件节点类型（契约 §10 演示第 3 条的分配语义）
STEP_KIND_TO_NODE_KIND = {"classical": "cpu", "quantum": "qpu", "agent": "gpu"}

#: 步骤终态集合
_TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
#: 会终结下游可行性的状态（失败或已被级联取消）
_DEAD = frozenset({"failed", "cancelled"})

StepRunner = Callable[[Step], Awaitable[str]]
#: agent 步子运行执行器：(task, step) → detail（dispatch_agent 步专用，
#: v1.3：时长=子运行真实总时长 measured，内存不可得 → null）
AgentStepExecutor = Callable[[Task, Step], Awaitable[str]]


class Scheduler:
    """进程内任务调度器（asyncio 单线程假设）。"""

    def __init__(
        self,
        config,  # SchedulerConfig（避免循环导入用鸭子类型）
        allocator: Allocator,
        events: EventBus,
        *,
        runner: StepRunner = simulate_step,
        poll_interval: float = 0.05,
        task_persister: Callable[[Task], None] | None = None,
        on_task_finished: Callable[[Task], None] | None = None,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval must be > 0")
        self._max_parallel = config.max_parallel_steps
        self._step_timeout = config.step_timeout_seconds
        self._retry_failed = config.retry_failed_steps
        self._allocator = allocator
        self._events = events
        self._runner = runner
        self._poll_interval = poll_interval
        self._on_task_finished = on_task_finished
        #: v1.9 SQLite 持久化：每次 _publish（状态迁移全量帧）同步落库；
        #: None = 内存态（测试 Rig），行为不变。
        self._task_persister = task_persister
        self._agent_executor: AgentStepExecutor | None = None
        self._active_steps = 0  # 全局运行中步数（跨任务，≤ max_parallel_steps）

    def bind_agent_executor(self, executor: AgentStepExecutor) -> None:
        """绑定 agent 步的子运行执行器（组装根在 Runtime 就绪后注入）。

        未绑定时 agent 步回退到普通 runner（单元测试路径，见 runners.py）。
        """
        self._agent_executor = executor

    # ---------- 提交 ----------

    def submit(self, task: Task, *, agent_id: str | None = None) -> asyncio.Task:
        """提交一个已构建的任务，立即返回后台编排协程的 Task。

        :raises ValidationFailed: steps 不是合法 DAG（契约 §4 不变量 1）。
        """
        validate_dag(task.steps)
        if task.status not in ("pending",):
            raise SchedulingError(f"task {task.id} is not pending (status={task.status})")
        self._publish(task)  # 首帧：pending 全量
        return asyncio.get_running_loop().create_task(self._orchestrate(task, agent_id))

    # ---------- 编排主循环 ----------

    async def _orchestrate(self, task: Task, agent_id: str | None) -> Task:
        """驱动一个任务直至终态；返回终态 Task（供测试 await 断言）。"""
        wake = asyncio.Event()
        running: dict[str, asyncio.Task] = {}
        retried: set[str] = set()
        try:
            while True:
                self._reap(running)
                self._cascade_cancel(task)
                self._launch_ready(task, agent_id, running, wake)
                if task.status == "pending" and any(s.status == "running" for s in task.steps):
                    task.status = "running"
                    self._publish(task)
                self._maybe_retry(task, retried, agent_id, running)
                if all(s.status in _TERMINAL for s in task.steps):
                    break
                try:  # 事件优先，轮询兜底
                    await asyncio.wait_for(wake.wait(), timeout=self._poll_interval)
                except (asyncio.TimeoutError, TimeoutError):
                    pass
                wake.clear()
        finally:
            await self._shutdown(task, running)
        self._finalize(task)
        return task

    async def _shutdown(self, task: Task, running: dict[str, asyncio.Task]) -> None:
        """循环退出（正常/异常）后的清理：取消残余执行、兜底释放租约。"""
        for step_task in running.values():
            step_task.cancel()
        if running:
            await asyncio.gather(*running.values(), return_exceptions=True)
        self._allocator.release_task(task.id)

    def _finalize(self, task: Task) -> None:
        """判定终态并发布最后一帧 + 触发组装层回调（配额释放等）。"""
        task.status = (
            "succeeded"
            if all(s.status == "succeeded" for s in task.steps)
            else "failed"
        )
        self._publish(task)
        if self._on_task_finished is not None:
            self._on_task_finished(task)

    # ---------- 单次推进 ----------

    def _reap(self, running: dict[str, asyncio.Task]) -> None:
        """收割已完成的执行任务（_execute 保证不抛，此处仅清理字典）。"""
        for step_id, step_task in list(running.items()):
            if step_task.done():
                _ = step_task.exception()  # 触发异常消费；None 为常态
                running.pop(step_id, None)

    def _cascade_cancel(self, task: Task) -> None:
        """把依赖已失败/取消的 pending 步标记为 cancelled（契约：任务视依赖定成败）。"""
        status_by_id = {s.id: s.status for s in task.steps}
        for step in task.steps:
            if step.status != "pending":
                continue
            dead = [d for d in step.depends_on if status_by_id.get(d) in _DEAD]
            if dead:
                step.status = "cancelled"
                step.error = f"upstream step(s) not succeeded: {', '.join(dead)}"
                self._publish(task)

    def _launch_ready(
        self,
        task: Task,
        agent_id: str | None,
        running: dict,
        wake: asyncio.Event,
    ) -> None:
        """启动所有就绪步（依赖全部 succeeded 且容量/并行额度允许）。"""
        status_by_id = {s.id: s.status for s in task.steps}
        for step in task.steps:
            if step.status != "pending":
                continue
            if not all(status_by_id.get(d) == "succeeded" for d in step.depends_on):
                continue
            if self._active_steps >= self._max_parallel:
                break  # 全局并行满：本轮不再启动（下一轮再试）
            node_kind = STEP_KIND_TO_NODE_KIND[step.kind]
            # v1.7 修订：classical 步的代码在 gpu/cpu 计算节点上都可执行
            # （两者均配 exec_url worker）——cpu 无在线节点时回退 gpu 池
            if (
                node_kind == "cpu"
                and step.workload.get("code")
                and not self._allocator.has_online_node("cpu")
                and self._allocator.has_online_node("gpu")
            ):
                node_kind = "gpu"
            if not self._allocator.has_online_node(node_kind):
                step.status = "failed"
                step.error = f"no online {node_kind!r} node for step {step.id!r}"
                self._publish(task)
                continue
            lease = self._allocator.try_lease(
                node_kind, task_id=task.id, step_id=step.id, agent_id=agent_id
            )
            if lease is None:
                continue  # 容量暂满：保持 pending，等待释放
            step.status = "running"
            step.started_at = utcnow_iso_ms()  # 毫秒精度：不变量 5 的 ±50ms 容差
            step.node_id = self._allocator.node_id_of(step.id)
            step.error = None
            self._active_steps += 1
            self._publish(task)
            running[step.id] = asyncio.get_event_loop().create_task(
                self._execute(task, step, wake)
            )

    def _maybe_retry(self, task: Task, retried: set[str], agent_id, running: dict) -> None:
        """retry_failed_steps=true 时，失败步重置 pending 重跑一次（每步至多一次）。"""
        if not self._retry_failed:
            return
        for step in task.steps:
            if step.status == "failed" and step.id not in retried:
                retried.add(step.id)
                step.status = "pending"
                step.error = None
                step.started_at = None
                step.finished_at = None
                step.duration_ms = None  # 重跑前清空上一轮实测（measured 语义）
                step.peak_memory_mb = None
                self._publish(task)

    # ---------- 步骤执行体 ----------

    async def _execute(self, task: Task, step: Step, wake: asyncio.Event) -> None:
        """单个步骤的执行协程：超时控制、状态落定、租约释放、事件发布。

        v1.3 实测 profile（measured）：``duration_ms`` = 本协程执行期的
        ``perf_counter`` 墙钟差（覆盖 runner 全程——满足不变量 5 的
        ``≈ finished_at - started_at`` ±50ms）；``peak_memory_mb`` 由
        quantum/classical runner 在同步负载块内以 tracemalloc 实测写入，
        dispatch_agent 步（子运行执行器路径）内存不可得 → null。

        无论成败，``finally`` 里都会释放租约、归还并行额度、发布全量帧并
        ``wake.set()`` —— 编排循环因此无需依赖轮询即可立刻推进。
        """
        started = perf_counter()
        try:
            executor = self._agent_executor if step.kind == "agent" else None
            # v1.4：执行期间把所属 Task 挂进运行上下文——云 runner 轮询
            # queue_position 时经此取回 Task 推 task.updated（协议签名不变）。
            with running_task_scope(task):
                if executor is not None:
                    detail = await asyncio.wait_for(
                        executor(task, step), timeout=self._step_timeout
                    )
                else:
                    detail = await asyncio.wait_for(
                        self._runner(step), timeout=self._step_timeout
                    )
            step.status = "succeeded"
            step.detail = detail
        except asyncio.TimeoutError:
            step.status = "failed"
            step.error = f"step timed out after {self._step_timeout}s"
        except asyncio.CancelledError:
            raise  # 编排层取消（如测试收尾），保持取消语义
        except Exception as exc:  # runner 自身异常 → 步骤失败而非崩掉调度器
            step.status = "failed"
            step.error = f"runner error: {exc}"
        finally:
            step.duration_ms = round((perf_counter() - started) * 1000, 1)
            step.finished_at = utcnow_iso_ms()
            self._allocator.release(step.id)
            self._active_steps -= 1
            self._publish(task)
            wake.set()

    # ---------- 事件 ----------

    def _publish(self, task: Task) -> None:
        """状态迁移 → task.updated（全量 Task，契约 §7）。"""
        self._events.publish(
            "task.updated",
            {
                "task_id": task.id,
                "status": task.status,
                "steps": [s.model_dump() for s in task.steps],
            },
            conversation_id=task.conversation_id,
        )
        if self._task_persister is not None:
            self._task_persister(task)

    # ---------- 查询（测试/监控） ----------

    @property
    def active_steps(self) -> int:
        """平台当前运行中的步数（应恒 ≤ max_parallel_steps）。"""
        return self._active_steps
