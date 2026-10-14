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
        assert [i.id for i in infos] == [
            "algorithm-designer", "calibration", "echo", "orchestrator",
        ]
        assert all(i.builtin for i in infos)
        assert "circuit-synthesis" in infos[0].capabilities

    def test_orchestrator_prompt_lists_experts_dynamically(self, rig: Rig) -> None:
        """v1.1：编排提示按已注册专家动态合成（含专家 id 与工具说明）。"""
        plugin = rig.plugins.get("orchestrator")
        assert "algorithm-designer" in plugin.system_prompt
        assert "dispatch_agent" in plugin.system_prompt

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

    def test_plugins_dir_without_manifests_ignored(self, tmp_path) -> None:
        """B3 语义：plugins_dir 缺失/无 plugin.json 子目录 = 无外部插件，正常。"""
        plugins_dir = tmp_path / "plugins"
        plugins_dir.mkdir()
        (plugins_dir / "not-a-plugin.txt").write_text("stray file", encoding="utf-8")
        (plugins_dir / "no-manifest").mkdir()
        agents_cfg = AgentsConfig(
            default_model_ref="default", plugins_dir=str(plugins_dir), builtin={},
        )
        registry = PluginRegistry(agents_cfg)
        # 无外部插件加载（仅内置四件套），也不报错
        assert [i.id for i in registry.list()] == [
            "algorithm-designer", "calibration", "echo", "orchestrator",
        ]

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


class TestModelRefDefaultAlias:
    """v1.4：插件 model_ref="default" 为保留别名 → agents.default_model_ref。

    真实联调缺陷（2026-10-14）：内置插件 model_ref 字面指向 [models.default]
    （mock 渠道），在 default_model_ref 配置为真实渠道的部署里，dispatch 出去
    的专家仍走演示剧本——模板回复+编造计数。别名仅作用于**插件绑定**，
    消息级覆盖（UI 显式选渠道）保持字面语义。
    """

    def _rig_with_spy(self) -> tuple["Rig", list[str]]:
        """构造带 provider 引用侦测的 Rig（脚本用 echo 类单轮文本）。"""
        rig = Rig()
        seen: list[str] = []

        def spy(model_ref: str) -> LLMProvider:
            seen.append(model_ref)
            return rig.provider

        rig.runtime = AgentRuntime(
            rig.plugins,
            spy,
            rig.tools,
            rig.bus,
            model_ref_alias=lambda ref: "glm-5.3-flash" if ref == "default" else ref,
        )
        return rig, seen

    async def test_run_resolves_alias_for_plugin_binding(self) -> None:
        rig, seen = self._rig_with_spy()
        conv = rig.new_conversation("echo")
        rig.append_message(conv, "user", "你好")
        assistant = rig.append_message(conv, "assistant", "")
        history = [m for m in rig.messages.list(conv.id) if m.id != assistant.id]
        await rig.runtime.run(conv, history, assistant)
        # echo 插件 model_ref="default" → 别名解析为 default_model_ref 指向的渠道
        assert seen == ["glm-5.3-flash"]

    async def test_message_level_override_stays_literal(self) -> None:
        rig, seen = self._rig_with_spy()
        conv = rig.new_conversation("echo")
        rig.append_message(conv, "user", "你好")
        assistant = rig.append_message(conv, "assistant", "")
        history = [m for m in rig.messages.list(conv.id) if m.id != assistant.id]
        await rig.runtime.run(conv, history, assistant, model_ref="mock")
        # 消息级显式选择渠道：字面引用，不经别名
        assert seen == ["mock"]

    async def test_subagent_resolves_alias(self) -> None:
        from qap.agents.tools import ToolContext

        rig, seen = self._rig_with_spy()
        ctx = ToolContext(
            conversation_id="c-9", tenant_id="demo", agent_id="orchestrator",
            message_id="m-9", run_key="c-9:m-9",
        )
        result = await rig.runtime.run_subagent(ctx, "echo", "回声测试")
        assert "error" not in result
        assert seen == ["glm-5.3-flash"]

    async def test_no_alias_keeps_literal_default(self) -> None:
        """未注入别名（既有组装/测试路径）：行为与历史一致（字面 default）。"""
        rig = Rig()
        seen: list[str] = []

        def spy(model_ref: str) -> LLMProvider:
            seen.append(model_ref)
            return rig.provider

        rig.runtime = AgentRuntime(rig.plugins, spy, rig.tools, rig.bus)
        conv = rig.new_conversation("echo")
        rig.append_message(conv, "user", "你好")
        assistant = rig.append_message(conv, "assistant", "")
        history = [m for m in rig.messages.list(conv.id) if m.id != assistant.id]
        await rig.runtime.run(conv, history, assistant)
        assert seen == ["default"]


class TestQueryTaskResultsTool:
    """v1.5 query_task_results：提交→执行→真实计数闭环读回（反编造）。"""

    async def test_returns_real_counts_after_cloud_completion(self) -> None:
        import json as _json

        rig = Rig()
        conv = rig.new_conversation("algorithm-designer")
        # 用 mock 剧本驱动 submit_task？更直接：手工经 PlatformTools 提交
        tools = rig.tools
        ctx = type("C", (), {})()
        # 构造 ToolContext
        from qap.agents.tools import ToolContext

        ctx = ToolContext(
            conversation_id=conv.id, tenant_id="demo",
            agent_id="algorithm-designer", message_id="m-1",
            run_key=f"{conv.id}:m-1",
        )
        submitted = _json.loads(
            await tools.execute(
                ctx,
                "submit_task",
                _json.dumps({
                    "name": "真实结果查询用例",
                    "steps": [{"name": "模拟步", "kind": "classical"}],
                }),
            )
        )
        assert "task_id" in submitted
        # 等调度完成
        for _ in range(200):
            snap = _json.loads(
                await tools.execute(
                    ctx, "query_task_results",
                    _json.dumps({"task_id": submitted["task_id"]}),
                )
            )
            if snap.get("status") in ("succeeded", "failed"):
                break
            await asyncio.sleep(0.02)
        assert snap["status"] == "succeeded"
        step = snap["steps"][0]
        assert step["node_id"] and step["duration_ms"] is not None
        assert "counts" in step  # 无真机时为 None，但字段必在（契约形状）

    async def test_unknown_or_cross_tenant_task_structured_error(self) -> None:
        import json as _json

        from qap.agents.tools import ToolContext

        rig = Rig()
        ctx = ToolContext(
            conversation_id="c-1", tenant_id="demo", agent_id="echo",
            message_id="m-1", run_key="c-1:m-1",
        )
        out = _json.loads(
            await rig.tools.execute(ctx, "query_task_results", '{"task_id": "t-999"}')
        )
        assert out.get("error") == "not_found"
        out2 = _json.loads(
            await rig.tools.execute(ctx, "query_task_results", "{}")
        )
        assert out2.get("error") == "validation_failed"
