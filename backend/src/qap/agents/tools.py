"""平台级工具（契约 §8）：所有 Agent 可用，由 Runtime 注入。

四个工具（声明即 JSON Schema，执行结果一律 JSON 字符串）：
- ``emit_artifact(artifact)``：附加可视化产物到当前消息。载荷经 §6 校验，
  非法载荷生成侧拒绝（错误以 ``{"error": ...}`` 回给模型，可自纠错）；
- ``submit_task(name, steps)``：提交 DAG 任务（steps 为 StepSpec 数组，
  depends_on 用前序下标）；受租户并发配额约束（QuotaError → 工具错误）；
- ``query_hardware()``：返回节点与活动分配（回答"哪个 Agent 在用哪块 GPU"）；
- ``dispatch_agent(agent_id, instruction)``（v1.1）：编排 Agent 独占——
  以目标专家的 system_prompt+tools 跑一轮子推理并返回其回复；非
  orchestrator 调用或嵌套超深（>1）→ 结构化工具错误（可自纠错）。
"""

from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

from qap.agents.plugins import ORCHESTRATOR_ID
from qap.core.clock import utcnow_iso
from qap.core.errors import QapError, ValidationFailed
from qap.core.ids import IdGenerator
from qap.domain.models import Artifact, Task
from qap.domain.store import TaskStore
from qap.events.bus import EventBus
from qap.orchestrator.dag import StepSpec, build_steps, validate_step_specs
from qap.orchestrator.scheduler import Scheduler
from qap.orchestrator.step_context import current_dispatch_step
from qap.tenancy.service import TenantService


@dataclass
class ToolContext:
    """一次 Agent 运行的工具执行上下文（平台工具的"当前消息"等锚点）。

    ``dispatch_depth``（v1.1 §8）：0 = 会话主运行；1 = 被 dispatch_agent
    派出的子运行（不可再分派）。
    """

    conversation_id: str
    tenant_id: str
    agent_id: str
    message_id: str
    run_key: str
    dispatch_depth: int = 0
    #: 本次运行累计的产物（Runtime 在 message.completed 时落库）
    pending_artifacts: list[Artifact] = field(default_factory=list)


class HardwareSnapshotFn(Protocol):
    """硬件快照提供者（NodeRegistry.snapshot 的依赖注入接口）。"""

    def __call__(self) -> list: ...


#: dispatch_agent 的执行器接口：(父上下文, 目标 agent, 指令) → 结构化结果。
#: 由 AgentRuntime.run_subagent 注入（组装期绑定，避免构造环）。
DispatcherFn = Callable[[ToolContext, str, str], Awaitable[dict]]


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
                                "circuit": {
                                    "type": "object",
                                    "description": (
                                        "v1.4 quantum 步线路（§6 载荷：qubits + "
                                        "operations[gate/targets/controls/theta]）；"
                                        "logicalcloud 模式将真实提交真机执行"
                                    ),
                                },
                                "shots": {
                                    "type": "integer",
                                    "description": "采样数（缺省 1024）",
                                },
                                "code": {
                                    "type": "string",
                                    "description": (
                                        "v1.7 classical 步 Python 源码——代码在"
                                        "计算节点机器上真实执行（后端只分发）；"
                                        "stdout/stderr/exit/实测时长经 "
                                        "query_task_results 的 result 字段读回"
                                    ),
                                },
                                "packages": {
                                    "type": "array", "items": {"type": "string"},
                                    "description": "节点环境预装包（pip，幂等）",
                                },
                                "node_id": {
                                    "type": "string",
                                    "description": (
                                        "指定执行节点（lq-<name> 或裸后端名；"
                                        "缺省自动选首个 online QPU）"
                                    ),
                                },
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

_QUERY_TASK_RESULTS_SPEC = {
    "name": "query_task_results",
    "description": (
        "查询已提交任务的真实执行结果：状态/每步的执行节点、云端任务 id、"
        "实测时长与真实测量计数 counts（真机 cloud-observed）。"
        "提交任务后轮询本工具获取真实计数，再基于真实数据完成最终分析——"
        "禁止在计数未返回前编造任何结果数值"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "submit_task 返回的任务 id"}
        },
        "required": ["task_id"],
    },
}

_DISPATCH_AGENT_SPEC = {
    "name": "dispatch_agent",
    "description": (
        "把子任务分派给一个领域专家 Agent 执行完整推理并返回其回复文本"
        "（仅编排助手 orchestrator 可用；专家的产物与任务自动归属当前会话）"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent_id": {"type": "string", "description": "目标专家 Agent id"},
            "instruction": {"type": "string", "description": "给专家的具体指令（含任务上下文）"},
        },
        "required": ["agent_id", "instruction"],
    },
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
        *,
        dispatcher: DispatcherFn | None = None,
        events: EventBus | None = None,
    ) -> None:
        """``events``（v1.4 §7）：注入总线后 ``emit_artifact`` 产生即推
        ``artifact.created``（前端流式插卡）；None = 本部署不外显（测试
        Rig 缺省，行为与 v1.3 完全一致——产物仍全量随 message.completed）。"""
        self._idgen = idgen
        self._tenants = tenants
        self._scheduler = scheduler
        self._tasks = tasks
        self._hardware_snapshot = hardware_snapshot
        self._dispatcher = dispatcher
        self._events = events

    def bind_dispatcher(self, dispatcher: DispatcherFn) -> None:
        """绑定 dispatch_agent 执行器（AgentRuntime.run_subagent，组装期）。"""
        self._dispatcher = dispatcher

    @staticmethod
    def specs() -> list[dict]:
        """四个平台工具的声明（dict 形态，避免运行时依赖 ToolSpec 类型）。"""
        return [
            _EMIT_ARTIFACT_SPEC,
            _SUBMIT_TASK_SPEC,
            _QUERY_HARDWARE_SPEC,
            _QUERY_TASK_RESULTS_SPEC,
            _DISPATCH_AGENT_SPEC,
        ]

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
            "query_task_results": self._query_task_results,
            "dispatch_agent": self._dispatch_agent,
        }
        handler = handlers.get(name)
        if handler is None:
            raise ValidationFailed(f"unknown tool {name!r}")
        try:
            result = handler(context, args)
            if inspect.isawaitable(result):  # 异步工具（dispatch_agent）
                result = await result
            return json.dumps(result, ensure_ascii=False)
        except QapError as exc:
            # 领域可纠错错误（载荷非法/配额超限/坏 DAG）→ 结构化回给模型
            return json.dumps(
                {"error": exc.code, "message": exc.message}, ensure_ascii=False
            )

    # ---------- 各工具实现 ----------

    def _emit_artifact(self, context: ToolContext, args: dict) -> dict:
        """构造并校验 Artifact，挂到运行上下文（§6：非法载荷生成侧拒绝）。

        v1.4 §7：注入总线时**产生即推** ``artifact.created``（载荷
        conversation_id/message_id/artifact）——前端流式插卡，无需等
        message.completed；completed 帧仍全量携带（既有事件不变）。
        """
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
        if self._events is not None:
            self._events.publish(
                "artifact.created",
                {
                    "conversation_id": context.conversation_id,
                    "message_id": context.message_id,
                    "artifact": artifact.model_dump(),
                },
                conversation_id=context.conversation_id,
            )
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
        # v1.3 记录提交深度：dispatch 子运行内提交的任务，其 agent 步
        # 不可再分派（"一次一层"）；见 scheduler 绑定的 agent 步执行器。
        task._submit_depth = context.dispatch_depth
        # v1.4 记录消息锚点：quantum 步自动 emit 的 counts artifact 经此
        # 定位归属消息（SSE artifact.created 与消息产物列表回写）。
        task._message_id = context.message_id
        self._tenants.register_task(context.tenant_id, task.id)  # 超配额 → QuotaError
        self._tasks.add(task)
        self._scheduler.submit(task, agent_id=context.agent_id)
        # v1.3 subtask_id 挂接：agent 步执行期间提交的任务自动挂到该步
        # （运行时上下文，一次一层；scope 外的提交不挂接）。
        dispatch_step = current_dispatch_step()
        if dispatch_step is not None:
            dispatch_step.subtask_id = task.id
        return {"task_id": task.id, "step_count": len(task.steps)}

    def _query_hardware(self, context: ToolContext, args: dict) -> dict:
        """全量节点与分配（§10 第 4 条的 Agent 侧视角）。"""
        nodes = [node.model_dump() for node in self._hardware_snapshot()]
        return {"nodes": nodes}

    def _query_task_results(self, context: ToolContext, args: dict) -> dict:
        """查询任务真实结果（v1.5：闭环读回真实计数，杜绝编造）。

        返回 task 快照 + 每步执行细节；quantum 步的真实计数缓存在
        step.workload["counts"]（cloud runner 完成时写入，运行时态不序列化，
        但本工具读取的是同一 Task 对象）。跨租户任务 → NotFound（404 语义）。
        """
        task_id = args.get("task_id")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ValidationFailed("query_task_results requires a 'task_id' string")
        task = self._tasks.get(task_id.strip(), context.tenant_id)
        return {
            "task_id": task.id,
            "name": task.name,
            "status": task.status,
            "steps": [
                {
                    "id": step.id,
                    "name": step.name,
                    "kind": step.kind,
                    "status": step.status,
                    "node_id": step.node_id,
                    "cloud_job_id": step.cloud_job_id,
                    "duration_ms": step.duration_ms,
                    "detail": step.detail,
                    "counts": (step.workload or {}).get("counts"),
                }
                for step in task.steps
            ],
        }

    async def _dispatch_agent(self, context: ToolContext, args: dict) -> dict:
        """dispatch_agent（§8 v1.1）：orchestrator 独占的专家分派。"""
        agent_id = str(args.get("agent_id") or "").strip()
        instruction = str(args.get("instruction") or "").strip()
        if not agent_id or not instruction:
            return {
                "error": "invalid_arguments",
                "message": "dispatch_agent requires 'agent_id' and 'instruction'",
            }
        if context.agent_id != ORCHESTRATOR_ID or context.dispatch_depth >= 1:
            return {
                "error": "dispatch_denied",
                "message": (
                    "dispatch_agent 仅编排助手 orchestrator 可用，且专家不能再分派"
                    "（嵌套深度=1）"
                ),
            }
        if self._dispatcher is None:  # 组装缺位（单测 Rig 未绑定时）防御
            return {
                "error": "dispatch_unavailable",
                "message": "dispatch_agent is not wired in this deployment",
            }
        return await self._dispatcher(context, agent_id, instruction)
