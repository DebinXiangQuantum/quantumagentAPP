"""logicalcloud 真机步骤执行器（契约 §9 v1.4 quantum 步真实执行）。

**数据性质声明**：本模块产出的一切任务状态/计数均为 **cloud-observed**
（云端真机观测）；``duration_ms`` 为调度器 perf_counter 实测（measured），
``peak_memory_mb`` 对云路径恒 null（远端执行，本地 tracemalloc 无意义）。

行为：
- 仅当 ``step.kind == "quantum"`` 且携带 ``circuit``（且注入了适配器）时
  走真机路径；其余（simulated 模式 / 无线路的 quantum 步 / classical /
  agent 回退路径）完全委托既有 :func:`simulate_step`（v1.3 真实计算负载，
  行为不变）。
- 真机路径：选节点（workload.node_id 指定 → 调度器租约节点 → 首个
  online lq-*；指定节点离线/未知 → 诚实报错）→ ``adapter.submit``
  （记录 ``step.cloud_job_id``）→ 轮询（``queue_position`` 变化经
  EventBus 推 ``task.updated``，``step.detail`` 记"云端排队 #n"）→
  completed → ``result_counts`` → **自动 emit counts artifact**（标题注明
  后端名与 job_id；计数守恒按云端实际返回合计——读出修正的 round 残差
  诚实计入）→ detail 记实测等待/执行时长。
- 失败：提交异常（CircuitError 等）或终态 failed/cancelled → 上抛
  （调度器落 ``step.error``，含服务端错误消息）；失败不产 counts artifact。

阻塞调用（requests）一律 ``asyncio.to_thread``——不卡事件循环；
``asyncio.CancelledError`` 原样传播（调度器取消语义）。
"""

from __future__ import annotations

import asyncio
from time import perf_counter
from typing import Any, Awaitable, Callable

from qap.domain.models import Step, Task
from qap.events.bus import EventBus
from qap.hardware.registry import NodeRegistry
from qap.orchestrator.runners import simulate_step
from qap.orchestrator.step_context import current_running_task

#: 契约 §9 v1.4：submit_task 步规格 shots 缺省值
DEFAULT_CLOUD_SHOTS = 1024

#: counts artifact 发射器签名：(task, step, type, title, payload) → 任意记录
ArtifactEmitter = Callable[[Task, Step, str, str, dict], Any]

#: StepRunner 签名（调度器协议）
StepRunnerFn = Callable[[Step], Awaitable[str]]


class CloudStepRunner:
    """quantum 步真机/本地双模执行器（调度器 runner 注入位）。"""

    def __init__(
        self,
        *,
        adapter: Any | None,
        registry: NodeRegistry,
        events: EventBus,
        artifact_emitter: ArtifactEmitter | None = None,
        fallback: StepRunnerFn = simulate_step,
        poll_interval: float = 1.0,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval must be > 0")
        self._adapter = adapter
        self._registry = registry
        self._events = events
        self._artifact_emitter = artifact_emitter
        self._fallback = fallback
        self._poll_interval = poll_interval

    async def __call__(self, step: Step) -> str:
        """调度器入口：真机条件满足走云端，否则委托既有负载。"""
        if self._adapter is None or step.kind != "quantum" or not step.circuit:
            return await self._fallback(step)
        return await self._run_cloud(step)

    # ---------- 真机路径 ----------

    async def _run_cloud(self, step: Step) -> str:
        circuit = step.circuit or {}
        shots = _positive_int((step.workload or {}).get("shots"), DEFAULT_CLOUD_SHOTS)
        backend_name, node_id = self._select_node(step)
        submitted_at = perf_counter()
        job = await asyncio.to_thread(
            self._adapter.submit, circuit, shots, backend_name
        )
        step.cloud_job_id = str(getattr(job, "job_id", "") or "")
        queued_since = perf_counter()
        # 轮询：queue_position 变化 → task.updated + detail"云端排队 #n"
        while True:
            info = await asyncio.to_thread(self._adapter.poll, job)
            status = str(info.get("status") or "")
            position = info.get("queue_position")
            if position != step.queue_position:
                step.queue_position = position
                if status in ("queued", "pending") and position is not None:
                    step.detail = (
                        f"logicalcloud 真机任务排队中（cloud-observed）："
                        f"云端排队 #{position}（backend {backend_name}，"
                        f"job {step.cloud_job_id}）"
                    )
                self._publish_task_update()
            if status == "completed":
                break
            if status in ("failed", "cancelled"):
                await self._raise_server_error(job, backend_name, status)
            await asyncio.sleep(self._poll_interval)
        started_at = perf_counter()
        counts = await asyncio.to_thread(self._adapter.result_counts, job)
        executed_for = perf_counter() - started_at
        waited_for = started_at - queued_since
        step.queue_position = None  # 已完成：清位（终态帧不残留排队信息）
        self._publish_task_update()
        detail = self._emit_counts_artifact(
            step, backend_name, circuit, shots, counts, waited_for, executed_for
        )
        return detail

    def _select_node(self, step: Step) -> tuple[str, str]:
        """选执行节点：指定（workload.node_id）→ 租约节点（step.node_id）→
        首个 online lq-*；返回 (backend 名, 注册表节点 id)。

        指定节点未知/离线 → 诚实报错（不静默改投其它机器）。
        """
        registry = self._registry
        preferred = (step.workload or {}).get("node_id") or (
            step.node_id if str(step.node_id or "").startswith("lq-") else None
        )
        if preferred:
            resolved = _resolve_node_id(str(preferred))
            node = registry.find(resolved)
            if node is None or node.kind != "qpu":
                raise RuntimeError(
                    f"logicalcloud execution failed: unknown QPU node {resolved!r}"
                )
            if node.status != "online":
                raise RuntimeError(
                    f"logicalcloud execution failed: node {resolved!r} is offline"
                )
            return _backend_name(resolved), resolved
        for node_id in registry.all_ids():
            node = registry.get(node_id)
            if node.kind == "qpu" and node.status == "online" and node_id.startswith("lq-"):
                return _backend_name(node_id), node_id
        raise RuntimeError(
            "logicalcloud execution failed: no online lq-* QPU node available"
        )

    async def _raise_server_error(self, job, backend_name: str, status: str) -> None:
        """终态 failed/cancelled：取服务端错误并上抛（调度器落 step.error）。"""
        try:
            await asyncio.to_thread(self._adapter.result_counts, job)
        except Exception as exc:  # SDK JobError 携带服务端消息
            raise RuntimeError(
                f"logicalcloud job on {backend_name!r} {status}: {exc}"
            ) from exc
        raise RuntimeError(  # pragma: no cover - result 对失败任务必抛
            f"logicalcloud job on {backend_name!r} {status} (no server detail)"
        )

    def _emit_counts_artifact(
        self,
        step: Step,
        backend_name: str,
        circuit: dict,
        requested_shots: int,
        counts: dict[str, int],
        waited_for: float,
        executed_for: float,
    ) -> str:
        """counts artifact 自动发射 + detail 组装（cloud-observed 标注）。

        计数守恒按云端**实际返回合计**（读出修正后 SDK round 取整，
        可能偏离请求 shots ±1——payload.shots 诚实取实际值）。
        """
        detail = (
            f"logicalcloud 真机执行（cloud-observed）：backend {backend_name}，"
            f"job {step.cloud_job_id}，等待 {waited_for:.1f}s / 执行 "
            f"{executed_for:.1f}s（duration_ms 为调度器 perf_counter 实测）"
        )
        if not counts:
            return detail + "；云端返回空计数（未产 counts artifact）"
        payload = {
            "shots": sum(counts.values()),
            "qubits": int(circuit.get("qubits") or 1),
            "counts": counts,
        }
        title = f"{backend_name} 实测计数（job {step.cloud_job_id}，cloud-observed）"
        if self._artifact_emitter is not None:
            task = current_running_task()
            if task is not None:
                self._artifact_emitter(task, step, "counts", title, payload)
                detail += f"；已产 counts artifact（{len(counts)} 项，{payload['shots']} shots）"
            else:  # 运行上下文缺失（非调度器路径）：只记 detail，不丢结果
                detail += f"；counts {len(counts)} 项（{payload['shots']} shots）"
        return detail

    def _publish_task_update(self) -> None:
        """queue_position 推进 → task.updated 全量帧（契约 §7 v1.4）。"""
        task = current_running_task()
        if task is None:
            return
        self._events.publish(
            "task.updated",
            {
                "task_id": task.id,
                "status": task.status,
                "steps": [s.model_dump() for s in task.steps],
            },
            conversation_id=task.conversation_id,
        )


# ---------- 助手 ----------

def _positive_int(value: Any, default: int) -> int:
    """读取正整数参数；缺失/畸形回退默认（畸形不掩盖：shots>0 已在提交期校验）。"""
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _resolve_node_id(raw: str) -> str:
    """节点参数归一：裸后端名（MQ02）→ 注册表 id（lq-MQ02）。"""
    if raw.startswith("lq-"):
        return raw
    return f"lq-{raw}"


def _backend_name(node_id: str) -> str:
    """注册表节点 id → 云端后端名（去 lq- 前缀）。"""
    return node_id[3:] if node_id.startswith("lq-") else node_id


__all__ = ["CloudStepRunner", "DEFAULT_CLOUD_SHOTS"]
