"""平台级工具（契约 §8）：所有 Agent 可用，由 Runtime 注入。

三个工具（声明即 JSON Schema，执行结果一律 JSON 字符串）：
- ``emit_artifact(artifact)``：附加可视化产物到当前消息。载荷经 §6 校验，
  非法载荷生成侧拒绝（错误以 ``{"error": ...}`` 回给模型，可自纠错）；
- ``submit_task(name, steps)``：提交 DAG 任务（steps 为 StepSpec 数组，
  depends_on 用前序下标）；受租户并发配额约束（QuotaError → 工具错误）；
- ``query_hardware()``：返回节点与活动分配（回答"哪个 Agent 在用哪块 GPU"）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol

from qap.core.clock import utcnow_iso
from qap.core.errors import QapError, ValidationFailed
from qap.core.ids import IdGenerator
from qap.domain.models import Artifact, Task
from qap.domain.store import TaskStore
from qap.orchestrator.dag import StepSpec, build_steps, validate_step_specs
from qap.orchestrator.scheduler import Scheduler
from qap.tenancy.service import TenantService


@dataclass
class ToolContext:
    """一次 Agent 运行的工具执行上下文（平台工具的"当前消息"等锚点）。"""

    conversation_id: str
    tenant_id: str
    agent_id: str
    message_id: str
    run_key: str
    #: 本次运行累计的产物（Runtime 在 message.completed 时落库）
    pending_artifacts: list[Artifact] = field(default_factory=list)


class HardwareSnapshotFn(Protocol):
    """硬件快照提供者（NodeRegistry.snapshot 的依赖注入接口）。"""

    def __call__(self) -> list: ...


_EMIT_ARTIFACT_SPEC = {
    "name": "emit_artifact",
    "description": "附加一个可视化产物（circuit/counts/waveform）到当前回复消息",
    "parameters": {
        "type": "object",
        "properties": {
            "artifact": {
                "type": "object",
                "description": "产物信封：{type, title, payload}",
                "properties": {
                    "type": {"type": "string"},
                    "title": {"type": "string"},
                    "payload": {"type": "object"},
                },
                "required": ["type", "payload"],
            }
        },
        "required": ["artifact"],
    },
}

_SUBMIT_TASK_SPEC = {
    "name": "submit_task",
    "description": "提交一个 DAG 任务（依赖用前序步骤下标表达）交由平台调度",
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "任务名"},
            "steps": {
                "type": "array",
                "description": "步骤数组；depends_on 引用更早元素的下标",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "kind": {"type": "string", "enum": ["classical", "quantum", "agent"]},
                        "detail": {"type": "string"},
                        "depends_on": {"type": "array", "items": {"type": "integer"}},
                    },
                    "required": ["name", "kind"],
                },
            },
        },
        "required": ["name", "steps"],
    },
}

_QUERY_HARDWARE_SPEC = {
    "name": "query_hardware",
    "description": "查询硬件节点与活动分配（谁在用哪块 GPU/QPU/CPU）",
    "parameters": {"type": "object", "properties": {}},
}


class PlatformTools:
    """平台工具的声明与执行（execute 是 Runtime 工具循环的唯一入口）。"""

    def __init__(
        self,
        idgen: IdGenerator,
        tenants: TenantService,
        scheduler: Scheduler,
        tasks: TaskStore,
        hardware_snapshot: HardwareSnapshotFn,
    ) -> None:
        self._idgen = idgen
        self._tenants = tenants
        self._scheduler = scheduler
        self._tasks = tasks
        self._hardware_snapshot = hardware_snapshot

    @staticmethod
    def specs() -> list[dict]:
        """三个平台工具的声明（dict 形态，避免运行时依赖 ToolSpec 类型）。"""
        return [_EMIT_ARTIFACT_SPEC, _SUBMIT_TASK_SPEC, _QUERY_HARDWARE_SPEC]

    async def execute(self, context: ToolContext, name: str, arguments: str) -> str:
        """执行工具；结果/错误都以 JSON 字符串返回（模型可读、可自纠错）。

        :raises ValidationFailed: 工具名未知（编程错误，非模型可纠错）。
        """
        try:
            args = json.loads(arguments) if arguments.strip() else {}
        except json.JSONDecodeError as exc:
            return json.dumps({"error": "invalid_arguments", "message": str(exc)}, ensure_ascii=False)
        if not isinstance(args, dict):
            return json.dumps({"error": "invalid_arguments", "message": "arguments must be an object"})
        handlers = {
            "emit_artifact": self._emit_artifact,
            "submit_task": self._submit_task,
            "query_hardware": self._query_hardware,
        }
        handler = handlers.get(name)
        if handler is None:
            raise ValidationFailed(f"unknown tool {name!r}")
        try:
            result = handler(context, args)
            return json.dumps(result, ensure_ascii=False)
        except QapError as exc:
            # 领域可纠错错误（载荷非法/配额超限/坏 DAG）→ 结构化回给模型
            return json.dumps(
                {"error": exc.code, "message": exc.message}, ensure_ascii=False
            )

    # ---------- 各工具实现 ----------

    def _emit_artifact(self, context: ToolContext, args: dict) -> dict:
        """构造并校验 Artifact，挂到运行上下文（§6：非法载荷生成侧拒绝）。"""
        envelope = args.get("artifact")
        if not isinstance(envelope, dict):
            raise ValidationFailed("emit_artifact requires an 'artifact' object")
        artifact = Artifact(
            id=self._idgen.next("a"),
            type=str(envelope.get("type", "")),
            title=str(envelope.get("title", "")),
            payload=envelope.get("payload", {}),
        )
        context.pending_artifacts.append(artifact)
        return {"artifact_id": artifact.id, "type": artifact.type}

    def _submit_task(self, context: ToolContext, args: dict) -> dict:
        """构建 DAG 任务：配额登记 → 入库 → 调度（QuotaError 结构化返回）。"""
        specs_raw = args.get("steps")
        if not isinstance(specs_raw, list) or not specs_raw:
            raise ValidationFailed("submit_task requires a non-empty 'steps' array")
        specs = [StepSpec.model_validate(item) for item in specs_raw]
        validate_step_specs(specs)
        task = Task(
            id=self._idgen.next("t"),
            conversation_id=context.conversation_id,
            tenant_id=context.tenant_id,
            name=str(args.get("name") or "未命名任务"),
            steps=build_steps(specs, self._idgen),
            created_at=utcnow_iso(),
        )
        self._tenants.register_task(context.tenant_id, task.id)  # 超配额 → QuotaError
        self._tasks.add(task)
        self._scheduler.submit(task, agent_id=context.agent_id)
        return {"task_id": task.id, "step_count": len(task.steps)}

    def _query_hardware(self, context: ToolContext, args: dict) -> dict:
        """全量节点与分配（§10 第 4 条的 Agent 侧视角）。"""
        nodes = [node.model_dump() for node in self._hardware_snapshot()]
        return {"nodes": nodes}
