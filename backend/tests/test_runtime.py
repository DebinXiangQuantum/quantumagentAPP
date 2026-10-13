"""S7 插件注册表 / 平台工具 / Runtime 工具循环测试。

- 不变量：emit_artifact 产物通过 §6 校验；submit_task 产出合法 DAG 且
  租约守恒；MAX 轮次安全上限生效。
- 非法输入拒绝：未知 agent、重复插件 id、坏 artifact 载荷（工具结果
  结构化报错而非崩溃）、坏 DAG steps、外部插件目录未实现。
- 负样本：provider 故障注入 → SSE error + 部分文本收束。
- 可观察行为：SSE 事件顺序（delta* → completed(artifacts)）、
  message.completed 后任务已入库、工具结果回填驱动第二轮。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from qap.agents.plugins import PluginRegistry
from qap.agents.providers.base import LLMProvider
from qap.agents.providers.mock_provider import MockProvider, default_demo_artifacts
from qap.agents.runtime import AgentRuntime
from qap.agents.tools import PlatformTools
from qap.core.config import (
    AgentsConfig,
    BuiltinAgentConfig,
    HardwareConfig,
    HardwareNodeConfig,
    SchedulerConfig,
    TenancyConfig,
    TenantConfig,
)
from qap.core.errors import NotFoundError, QapError
from qap.core.ids import IdGenerator
from qap.domain.models import Conversation, Message
from qap.domain.store import ConversationStore, MessageStore, TaskStore
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import NodeRegistry
from qap.orchestrator.scheduler import Scheduler
from qap.tenancy.service import TenantService


# ---------- 组装脚手架 ----------

def make_config(**overrides) -> tuple[AgentsConfig, HardwareConfig, SchedulerConfig, TenancyConfig]:
    agents = overrides.pop("agents", None) or AgentsConfig(
        default_model_ref="default",
        plugins_dir="",
        builtin={
            "algorithm-designer": BuiltinAgentConfig(enabled=True, model_ref="default"),
            "calibration": BuiltinAgentConfig(enabled=True, model_ref="default"),
            "echo": BuiltinAgentConfig(enabled=True, model_ref="default"),
        },
    )
    hardware = overrides.pop("hardware", None) or HardwareConfig(
        simulated=False,
        tick_seconds=60.0,
        nodes=[
            HardwareNodeConfig(id="qpu-0", kind="qpu", name="Q", model="m", capacity=1),
            HardwareNodeConfig(id="gpu-0", kind="gpu", name="G", model="m", capacity=1),
            HardwareNodeConfig(id="cpu-0", kind="cpu", name="C", model="m", capacity=4),
        ],
    )
    scheduler = SchedulerConfig(max_parallel_steps=4, step_timeout_seconds=5.0, retry_failed_steps=False)
    tenancy = TenancyConfig(
        default_tenant="demo",
        tenants=[TenantConfig(id="demo", name="Demo", api_key="demo-key",
                              max_concurrent_tasks=2, max_messages_per_day=100)],
    )
    return agents, hardware, scheduler, tenancy


class Rig:
    """把 S3-S6 组件组装成可运行的最小平台（测试与 S8 组装层的预演）。"""

    def __init__(self, scripts: dict[str, list[list[tuple]]] | None = None) -> None:
        agents_cfg, hardware_cfg, scheduler_cfg, tenancy_cfg = make_config()
        self.idgen = IdGenerator()
        self.bus = EventBus()
        self.registry = NodeRegistry(hardware_cfg)
        self.allocator = Allocator(self.registry, self.bus)
        self.scheduler = Scheduler(scheduler_cfg, self.allocator, self.bus, poll_interval=0.01)
        self.tenants = TenantService(tenancy_cfg)
        self.tasks = TaskStore()
        self.plugins = PluginRegistry(agents_cfg)
        self.provider = MockProvider(scripts)
        self.tools = PlatformTools(
            self.idgen, self.tenants, self.scheduler, self.tasks, self.registry.snapshot
        )
        self.runtime = AgentRuntime(
            self.plugins, lambda model_ref: self.provider, self.tools, self.bus
        )
        self.conversations = ConversationStore()
        self.messages = MessageStore()

    def new_conversation(self, agent_id: str = "algorithm-designer", tenant_id: str = "demo") -> Conversation:
        conversation = Conversation(
            id=self.idgen.next("c"), title="测试会话", agent_id=agent_id,
            tenant_id=tenant_id, created_at="2026-10-13T06:00:00Z",
        )
        self.conversations.add(conversation)
        return conversation

    def append_message(self, conversation: Conversation, role: str, content: str) -> Message:
        message = Message(
            id=self.idgen.next("m"), conversation_id=conversation.id, role=role,
            content=content, agent_id=conversation.agent_id,
            created_at="2026-10-13T06:00:01Z",
        )
        self.messages.add(message)
        return message

    async def chat(self, conversation: Conversation, user_text: str) -> Message:
        user = self.append_message(conversation, "user", user_text)
        assistant = self.append_message(conversation, "assistant", "")
        history = self.messages.list(conversation.id)[:-1]
        return await self.runtime.run(conversation, history, assistant)

    def collect_stream(self, conversation_id: str) -> list:
        sub = self.bus.subscribe(conversation_id)
        events = []
        while not sub.queue.empty():
            events.append(sub.queue.get_nowait())
        self.bus.unsubscribe(sub)
        return events

    async def wait_task_terminal(self, task_id: str, timeout: float = 5.0) -> str:
        """轮询等待任务进入终态（避免固定 sleep 的时序脆弱）。"""
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.tasks.get(task_id, "demo").status
            if status in ("succeeded", "failed", "cancelled"):
                return status
            await asyncio.sleep(0.02)
        return self.tasks.get(task_id, "demo").status


@pytest.fixture()
def rig() -> Rig:
    return Rig()


# ---------- 插件注册表 ----------

class TestPluginRegistry:
    def test_builtin_plugins_listed(self, rig: Rig) -> None:
        infos = rig.plugins.list()
        assert [i.id for i in infos] == ["algorithm-designer", "calibration", "echo"]
        assert all(i.builtin for i in infos)
        assert "circuit-synthesis" in infos[0].capabilities

    def test_unknown_agent_rejected(self, rig: Rig) -> None:
        with pytest.raises(NotFoundError):
            rig.plugins.get("ghost")

    def test_disabled_plugin_not_registered(self) -> None:
        agents_cfg, *_ = make_config()
        disabled = AgentsConfig(
            default_model_ref="default",
            plugins_dir="",
            builtin={
                "echo": BuiltinAgentConfig(enabled=False, model_ref="default"),
            },
        )
        registry = PluginRegistry(disabled)
        assert "echo" not in [i.id for i in registry.list()]

    def test_external_plugins_dir_unimplemented(self, tmp_path) -> None:
        """B1 过渡语义：目录非空才报"未实现"；缺失/空目录 = 无外部插件。"""
        plugins_dir = tmp_path / "plugins"
        plugins_dir.mkdir()
        # 空目录：正常（仓库默认 plugins_dir="plugins" 且目录通常不存在）
        agents_cfg = AgentsConfig(
            default_model_ref="default", plugins_dir=str(plugins_dir), builtin={},
        )
        PluginRegistry(agents_cfg)
        # 非空目录（含插件子目录）：v1.1 B3 切片实现前显式失败
        (plugins_dir / "some-plugin").mkdir()
        agents_cfg = AgentsConfig(
            default_model_ref="default", plugins_dir=str(plugins_dir), builtin={},
        )
        with pytest.raises(QapError, match="not implemented"):
            PluginRegistry(agents_cfg)

    def test_duplicate_plugin_rejected(self) -> None:
        agents_cfg, *_ = make_config()
        registry = PluginRegistry(agents_cfg)
        from qap.agents.plugins import BUILTIN_PLUGINS
        with pytest.raises(ValueError, match="duplicate"):
            registry.register(BUILTIN_PLUGINS[0])


# ---------- 平台工具 ----------

class TestPlatformTools:
    def make_context(self, rig: Rig, conversation: Conversation, message_id: str = "m-1"):
        from qap.agents.tools import ToolContext
        return ToolContext(
            conversation_id=conversation.id, tenant_id=conversation.tenant_id,
            agent_id=conversation.agent_id, message_id=message_id, run_key="test-run",
        )

    async def test_emit_artifact_appends_validated_payload(self, rig: Rig) -> None:
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        payload = json.dumps({
            "artifact": {"type": "counts", "title": "计数",
                         "payload": default_demo_artifacts()["counts"]},
        })
        result = json.loads(await rig.tools.execute(context, "emit_artifact", payload))
        assert result["artifact_id"].startswith("a-")
        assert len(context.pending_artifacts) == 1

    async def test_emit_artifact_rejects_bad_payload_structurally(self, rig: Rig) -> None:
        """非法载荷 → 生成侧拒绝：工具结果携带 error（模型可自纠错）。"""
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        bad = json.dumps({"artifact": {"type": "counts", "payload": {"shots": 5, "qubits": 1, "counts": {"0": 4}}}})
        result = json.loads(await rig.tools.execute(context, "emit_artifact", bad))
        assert result["error"] == "validation_failed"
        assert "sum" in result["message"]

    async def test_submit_task_creates_and_schedules(self, rig: Rig) -> None:
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        args = json.dumps({
            "name": "VQE 全流程",
            "steps": [
                {"name": "分子积分计算", "kind": "classical"},
                {"name": "VQE 线路执行", "kind": "quantum", "depends_on": [0]},
                {"name": "结果后处理", "kind": "classical", "depends_on": [1]},
            ],
        })
        result = json.loads(await rig.tools.execute(context, "submit_task", args))
        task = rig.tasks.get(result["task_id"], "demo")
        assert task.conversation_id == conversation.id
        assert await rig.wait_task_terminal(task.id) == "succeeded"

    async def test_submit_task_quota_error_structural(self, rig: Rig) -> None:
        """负样本：并发任务超配额 → 工具结果 error=quota_exceeded。"""
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        args = json.dumps({"name": "A", "steps": [{"name": "a", "kind": "classical"}]})
        await rig.tools.execute(context, "submit_task", args)
        await rig.tools.execute(context, "submit_task", args)  # 配额 2 已满
        result = json.loads(await rig.tools.execute(context, "submit_task", args))
        assert result["error"] == "quota_exceeded"

    async def test_submit_task_rejects_bad_dag(self, rig: Rig) -> None:
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        args = json.dumps({"name": "坏任务", "steps": [{"name": "a", "kind": "classical", "depends_on": [3]}]})
        result = json.loads(await rig.tools.execute(context, "submit_task", args))
        assert result["error"] == "validation_failed"

    async def test_query_hardware_returns_nodes(self, rig: Rig) -> None:
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        result = json.loads(await rig.tools.execute(context, "query_hardware", "{}"))
        assert len(result["nodes"]) == 3
        assert all("allocations" in node for node in result["nodes"])

    async def test_unknown_tool_raises(self, rig: Rig) -> None:
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        from qap.core.errors import ValidationFailed
        with pytest.raises(ValidationFailed):
            await rig.tools.execute(context, "no_such_tool", "{}")

    async def test_invalid_json_arguments_returned_structurally(self, rig: Rig) -> None:
        conversation = rig.new_conversation()
        context = self.make_context(rig, conversation)
        result = json.loads(await rig.tools.execute(context, "query_hardware", "{broken"))
        assert result["error"] == "invalid_arguments"


# ---------- Runtime 工具循环 ----------

class TestRuntimeToolLoop:
    async def test_full_demo_chain_observable_behavior(self, rig: Rig) -> None:
        """§10 第 1-4 条（无 HTTP 层版本）：delta 流 → 工具 → completed。"""
        conversation = rig.new_conversation("algorithm-designer")
        # 先订阅再跑，捕获全部事件
        sub = rig.bus.subscribe(conversation.id)
        assistant = await rig.chat(conversation, "请设计一个 VQE 方案")
        events = []
        while not sub.queue.empty():
            events.append(sub.queue.get_nowait())
        rig.bus.unsubscribe(sub)

        names = [e.name for e in events]
        # 可观察行为：先若干 message.delta，最后 message.completed；
        # 任务与硬件事件混排其中（message.completed 之前 submit_task 已执行）
        assert names.count("message.delta") >= 2
        assert names[-1] == "message.completed"
        assert "task.updated" in names and "hardware.updated" in names
        assert names.index("hardware.updated") < names.index("message.completed")
        # assistant 内容收束且产物合法
        assert "VQE" in assistant.content
        artifact_types = [a.type for a in assistant.artifacts]
        assert artifact_types == ["circuit", "counts"]
        completed = events[-1].data
        assert completed["message_id"] == assistant.id
        assert len(completed["artifacts"]) == 2
        # 任务已入库并完成
        tasks = rig.tasks.list_for_tenant("demo", conversation.id)
        assert len(tasks) == 1
        assert await rig.wait_task_terminal(tasks[0].id) == "succeeded"

    async def test_delta_seq_monotonic(self, rig: Rig) -> None:
        conversation = rig.new_conversation("echo")
        sub = rig.bus.subscribe(conversation.id)
        await rig.chat(conversation, "单调性检查")
        seqs = []
        while not sub.queue.empty():
            event = sub.queue.get_nowait()
            if event.name == "message.delta":
                seqs.append(event.data["seq"])
        rig.bus.unsubscribe(sub)
        assert seqs == sorted(seqs)

    async def test_provider_failure_partial_closure(self) -> None:
        """负样本：provider 故障 → SSE error + 部分文本收束 completed。"""
        scripts = {
            "algorithm-designer": [[("text", "先输出一半……"), ("error", "注入的 provider 故障")]],
        }
        rig = Rig(scripts)
        conversation = rig.new_conversation()
        sub = rig.bus.subscribe(conversation.id)
        assistant = await rig.chat(conversation, "q")
        events = []
        while not sub.queue.empty():
            events.append(sub.queue.get_nowait())
        rig.bus.unsubscribe(sub)
        names = [e.name for e in events]
        assert "error" in names
        assert names[-1] == "message.completed"
        assert assistant.content.startswith("先输出一半")
        assert assistant.artifacts == []

    async def test_tool_error_result_drives_next_turn(self) -> None:
        """坏载荷 → 工具结构化报错 → 剧本第二轮正常收束（模型可自纠错语义）。"""
        bad_counts = {"shots": 8, "qubits": 1, "counts": {"0": 9}}  # 和 != shots
        scripts = {
            "algorithm-designer": [
                [("tool", "emit_artifact", {"artifact": {"type": "counts", "payload": bad_counts}})],
                [("text", "已根据错误信息修正。")],
            ],
        }
        rig = Rig(scripts)
        conversation = rig.new_conversation()
        assistant = await rig.chat(conversation, "q")
        assert "修正" in assistant.content
        assert assistant.artifacts == []  # 坏产物被生成侧拒绝，未附加

    async def test_max_turns_safety_cap(self) -> None:
        """安全上限：每轮都发起工具调用的剧本在 MAX 轮后强制收束。"""
        endless = [[("tool", "query_hardware", {})]] * 50  # 永远不停
        scripts = {"algorithm-designer": endless}
        rig = Rig(scripts)
        conversation = rig.new_conversation()
        assistant = await rig.chat(conversation, "q")
        assert "轮次上限" in assistant.content
        assert assistant.content.endswith("收束。）")
