"""V2 步骤实测 profile 测试（契约 §4 v1.3 步骤执行=真实测量）。

**语义声明**：simulated runner 现在执行**真实的小型计算负载**——quantum
步为纯 Python 态矢量模拟、classical 步为 zlib 压缩/解压 JSON 负载；
``duration_ms``（perf_counter 差）与 ``peak_memory_mb``（tracemalloc 峰值）
是**真实执行的真实测量值（measured），非编造、亦非硬件观测**。

四类场景映射：
- 不变量（§4 不变量 5）：``duration_ms ≥ 0``；``peak_memory_mb > 0`` 或
  null；finished 步 ``duration_ms ≈ finished_at - started_at``（±50ms）；
  dispatch 步执行期间子 Agent 提交的任务恰好挂 ``subtask_id``（一次一层）。
- 非法输入拒绝：负 duration_ms 被模型校验拒绝；workload 非法值裁剪。
- 负样本：级联取消（未启动）步 profile 保持 null；嵌套 dispatch 的
  agent 步失败且不误挂外层 subtask_id。
- 可观察行为：序列化缺省 null；agent 步内存为 null、时长为子运行真实
  总时长；detail 文案标注 measured。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from qap.agents.providers.mock_provider import MockProvider
from qap.core.config import SchedulerConfig
from qap.core.ids import IdGenerator
from qap.domain.invariants import validate_step_profiles
from qap.domain.models import Step, Task
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import NodeRegistry
from qap.orchestrator.dag import StepSpec, build_steps
from qap.orchestrator.scheduler import Scheduler
from tests.test_api_integration import ClientBundle, make_test_config
from tests.test_hardware_metrics import node as hardware_node
from qap.core.config import HardwareConfig


def make_scheduler_rig(*, step_timeout: float = 30.0):
    """最小调度器 rig（qpu/gpu/cpu 各一，全在线）。"""
    registry = NodeRegistry(
        HardwareConfig(
            simulated=True,
            tick_seconds=60.0,
            nodes=[
                hardware_node(id="qpu-0", topology={"rows": 2, "cols": 2}),
                hardware_node(id="gpu-0", kind="gpu", vram_total_gb=80.0),
                hardware_node(id="cpu-0", kind="cpu", cpu_cores=8, memory_total_gb=64.0),
            ],
        )
    )
    bus = EventBus()
    scheduler = Scheduler(
        SchedulerConfig(max_parallel_steps=4, step_timeout_seconds=step_timeout,
                        retry_failed_steps=False),
        Allocator(registry, bus),
        bus,
        poll_interval=0.01,
    )
    return scheduler


def make_task(specs: list[StepSpec]) -> Task:
    return Task(
        id=IdGenerator().next("t"),
        conversation_id="c-1",
        tenant_id="demo",
        name="profile 测试任务",
        steps=build_steps(specs, IdGenerator()),
        created_at="2026-10-13T06:00:00Z",
    )


def parse_iso_ms(stamp: str) -> datetime:
    """解析毫秒精度 ISO-8601 UTC 时间戳（Z 后缀）。"""
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(timezone.utc)


async def scheduler_wait(submit_task_future) -> Task:
    """await scheduler.submit 返回的编排 Task 直至终态。"""
    return await submit_task_future


async def wait_task_terminal(bundle: ClientBundle, task_id: str, timeout: float = 8.0) -> Task:
    """轮询任务直至终态（内层任务异步执行，需等待其 agent 步被拒绝）。"""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        task = bundle.state.tasks.get(task_id, "demo")
        if task.status in ("succeeded", "failed", "cancelled"):
            return task
        await asyncio.sleep(0.02)
    raise AssertionError(f"inner task {task_id} did not reach terminal status")


# ---------- 序列化与模型校验 ----------

class TestStepProfileFields:
    def test_serialization_defaults_null(self) -> None:
        step = Step(id="s-1", name="a", kind="classical")
        payload = step.model_dump()
        assert payload["duration_ms"] is None
        assert payload["peak_memory_mb"] is None
        assert payload["subtask_id"] is None

    def test_negative_duration_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Step(id="s-1", name="a", kind="classical", duration_ms=-0.1)

    def test_assignment_validation_rejects_bad_profile(self) -> None:
        step = Step(id="s-1", name="a", kind="classical")
        with pytest.raises(ValidationError):
            step.duration_ms = -1.0
        with pytest.raises(ValidationError):
            step.peak_memory_mb = 0.0  # 不变量：> 0 或 null

    def test_workload_not_serialized(self) -> None:
        """workload 是 runner 的执行参数，不进入 Step 序列化（契约纯净）。"""
        step = Step(id="s-1", name="a", kind="quantum", workload={"qubits": 10})
        assert "workload" not in step.model_dump()


# ---------- 真实计算负载（quantum/classical） ----------

class TestRealWorkloads:
    async def test_quantum_step_measured_profile(self) -> None:
        scheduler = make_scheduler_rig()
        task = make_task([
            StepSpec(name="VQE 线路执行", kind="quantum", workload={"qubits": 12}),
        ])
        final = await scheduler.submit(task)
        step = final.steps[0]
        assert final.status == "succeeded"
        assert step.status == "succeeded"
        assert step.duration_ms is not None and step.duration_ms >= 0
        assert "measured" in step.detail

    async def test_quantum_big_workload_memory_measured(self) -> None:
        """2^14 幅度列表的态矢量模拟分配量在 MB 量级 → 峰值内存 > 0。"""
        scheduler = make_scheduler_rig()
        task = make_task([
            StepSpec(name="大模拟", kind="quantum", workload={"qubits": 14}),
        ])
        final = await scheduler.submit(task)
        step = final.steps[0]
        assert step.status == "succeeded"
        assert step.peak_memory_mb is not None and step.peak_memory_mb > 0

    async def test_classical_step_measured_profile(self) -> None:
        scheduler = make_scheduler_rig()
        task = make_task([StepSpec(name="分子积分", kind="classical")])
        final = await scheduler.submit(task)
        step = final.steps[0]
        assert step.status == "succeeded"
        assert step.duration_ms >= 0
        assert step.peak_memory_mb is not None and step.peak_memory_mb > 0
        assert "zlib" in step.detail or "measured" in step.detail

    async def test_duration_matches_timestamps_within_50ms(self) -> None:
        """不变量 5：finished 步 duration_ms ≈ finished_at - started_at（±50ms）。"""
        scheduler = make_scheduler_rig()
        task = make_task([
            StepSpec(name="经典步", kind="classical"),
            StepSpec(name="量子步", kind="quantum", workload={"qubits": 10},
                     depends_on=[0]),
        ])
        final = await scheduler.submit(task)
        # 对外校验函数整包复核（§4 v1.2 全部步骤不变量 + 不变量 5）
        validate_step_profiles(final)
        for step in final.steps:
            assert step.finished_at is not None and step.started_at is not None
            span_ms = (parse_iso_ms(step.finished_at) - parse_iso_ms(step.started_at)
                       ).total_seconds() * 1000
            assert abs(span_ms - (step.duration_ms or 0)) <= 50.0, (
                f"step {step.id}: duration={step.duration_ms} span={span_ms}"
            )

    async def test_unlaunched_step_keeps_null_profile(self) -> None:
        """负样本：上游失败 → 级联取消（从未启动）→ profile 全 null。"""
        scheduler = make_scheduler_rig(step_timeout=0.05)

        async def never_finish(step: Step) -> str:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")  # pragma: no cover

        # 直接构造带坏上游的任务：上游超时失败，下游级联取消
        scheduler._runner = never_finish
        task = make_task([
            StepSpec(name="慢步", kind="classical"),
            StepSpec(name="下游", kind="quantum", depends_on=[0]),
        ])
        final = await scheduler.submit(task)
        downstream = final.steps[1]
        assert downstream.status == "cancelled"
        assert downstream.duration_ms is None
        assert downstream.peak_memory_mb is None
        assert downstream.started_at is None and downstream.finished_at is None

    async def test_timeout_step_keeps_measured_duration(self) -> None:
        """超时失败步：墙钟被真实测量（≈ 超时阈值），不为 null。"""
        scheduler = make_scheduler_rig(step_timeout=0.15)

        async def slow(step: Step) -> str:
            await asyncio.sleep(5)
            return "never"  # pragma: no cover

        scheduler._runner = slow
        task = make_task([StepSpec(name="慢步", kind="classical")])
        final = await scheduler.submit(task)
        step = final.steps[0]
        assert step.status == "failed" and "timed out" in step.error
        assert step.duration_ms is not None and step.duration_ms >= 140


# ---------- dispatch_agent 步：子运行 + subtask_id 挂接 ----------

class TestDispatchStepProfile:
    @pytest.fixture()
    async def bundle(self) -> ClientBundle:
        instance = ClientBundle(make_test_config())
        yield instance
        await instance.app.state.qap.shutdown()
        await instance.http.aclose()

    def make_outer_task(self, cid: str, workload: dict) -> Task:
        return Task(
            id=IdGenerator().next("t"),
            conversation_id=cid,
            tenant_id="demo",
            name="外层任务",
            steps=build_steps(
                [StepSpec(name="专家分派", kind="agent", workload=workload)],
                IdGenerator(),
            ),
            created_at="2026-10-13T06:00:00Z",
        )

    async def test_agent_step_runs_real_subrun_and_links_subtask(
        self, bundle: ClientBundle
    ) -> None:
        """dispatch 步：真实子运行（时长 measured、内存 null）；执行期间
        子 Agent 经 submit_task 提交的任务自动挂 subtask_id。"""
        bundle.state.providers["default"] = MockProvider({
            "calibration": [
                [("text", "收到，提交一个子任务。"),
                 ("tool", "submit_task", {
                     "name": "内层任务",
                     "steps": [{"name": "内层经典", "kind": "classical"}],
                 })],
                [("text", "子任务已提交。")],
            ],
        })
        conversation = (await bundle.http.post(
            "/api/v1/conversations", json={"agent_id": "orchestrator"},
            headers={"Authorization": "Bearer demo-key"},
        )).json()
        task = self.make_outer_task(
            conversation["id"],
            {"agent_id": "calibration", "instruction": "请提交一个子任务"},
        )
        final = await bundle.state.scheduler.submit(task)
        step = final.steps[0]
        assert final.status == "succeeded", step.error
        assert step.status == "succeeded"
        assert step.duration_ms is not None and step.duration_ms >= 0
        assert step.peak_memory_mb is None  # dispatch 步内存不可得 → null
        assert step.subtask_id is not None
        inner = bundle.state.tasks.get(step.subtask_id, "demo")
        assert inner.conversation_id == conversation["id"]

    async def test_nested_dispatch_not_mislinked(self, bundle: ClientBundle) -> None:
        """一次一层：子 Agent（depth=1）提交的内层任务若再含 agent 步，
        该步被拒绝失败，且不误改外层步的 subtask_id。"""
        bundle.state.providers["default"] = MockProvider({
            "calibration": [
                [("tool", "submit_task", {
                    "name": "内层任务",
                    "steps": [
                        {"name": "嵌套分派", "kind": "agent",
                         "workload": {"agent_id": "calibration", "instruction": "再分派"}},
                    ],
                })],
                [("text", "已提交。")],
            ],
        })
        conversation = (await bundle.http.post(
            "/api/v1/conversations", json={}, headers={"Authorization": "Bearer demo-key"},
        )).json()
        task = self.make_outer_task(
            conversation["id"],
            {"agent_id": "calibration", "instruction": "提交内层任务"},
        )
        final = await scheduler_wait(bundle.state.scheduler.submit(task))
        outer = final.steps[0]
        assert outer.status == "succeeded"
        inner_id = outer.subtask_id
        assert inner_id is not None
        inner = await wait_task_terminal(bundle, inner_id)
        nested = inner.steps[0]
        assert nested.status == "failed"
        assert "nested" in (nested.error or "") or "dispatch" in (nested.error or "")
        assert outer.subtask_id == inner_id  # 未被嵌套层改写
        assert nested.subtask_id is None

    async def test_conversation_level_submit_task_not_linked(self, bundle: ClientBundle) -> None:
        """会话主运行（非 agent 步执行期）提交的任务不挂任何 subtask_id。"""
        bundle.state.providers["default"] = MockProvider({
            "orchestrator": [
                [("tool", "submit_task", {
                    "name": "会话任务",
                    "steps": [{"name": "普通步", "kind": "classical"}],
                })],
                [("text", "已提交。")],
            ],
        })
        conversation = (await bundle.http.post(
            "/api/v1/conversations", json={}, headers={"Authorization": "Bearer demo-key"},
        )).json()
        await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "提交任务"},
            headers={"Authorization": "Bearer demo-key"},
        )
        await asyncio.sleep(0.5)
        tasks = (await bundle.http.get(
            "/api/v1/tasks", headers={"Authorization": "Bearer demo-key"}
        )).json()
        assert len(tasks) == 1
        assert tasks[0]["steps"][0]["subtask_id"] is None

    async def test_agent_step_unknown_agent_fails(self, bundle: ClientBundle) -> None:
        task = self.make_outer_task("c-1", {"agent_id": "ghost", "instruction": "x"})
        final = await bundle.state.scheduler.submit(task)
        step = final.steps[0]
        assert step.status == "failed"
        assert "ghost" in (step.error or "")
        assert step.subtask_id is None
