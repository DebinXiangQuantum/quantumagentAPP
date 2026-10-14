"""V5 dispatch 实时外显 + artifact 即时事件测试（契约 §7 v1.4）。

四类场景：
- 不变量：agent.activity 事件序 dispatch_started →（reasoning_delta/
  text_delta/tool_call …）→ dispatch_completed，seq 单调递增且与帧 id
  一致；载荷按契约（conversation_id/message_id/agent_id/phase/delta?/tool?）。
- 非法输入拒绝：（无——本切片为纯外显；畸形由上游既有校验承担）。
- 负样本：主运行正文增量仍走 message.delta（agent.activity 只承载子运行，
  两股流不混淆）；子运行不发布 message.completed。
- 可观察行为：emit_artifact 产生即推 artifact.created（先于
  message.completed 可订阅）；message.completed 仍全量携带产物
  （既有事件不变）。
"""

from __future__ import annotations

import asyncio
import json

from qap.agents.providers.mock_provider import default_demo_artifacts
from qap.agents.runtime import AgentRuntime
from qap.agents.tools import PlatformTools, ToolContext
from tests.test_runtime import Rig


def drain(subscription) -> list:
    """无阻塞取空订阅队列（运行已 await 完成后调用）。"""
    events = []
    while not subscription.queue.empty():
        events.append(subscription.queue.get_nowait())
    return events


class TestDispatchActivityStream:
    async def test_activity_phases_ordered_and_seq_monotonic(self) -> None:
        """dispatch 全程外显：started → 增量族 → completed，seq 严格递增。"""
        rig = Rig()
        rig.tools.bind_dispatcher(rig.runtime.run_subagent)  # Rig 缺省不绑定
        conversation = rig.new_conversation("orchestrator")
        subscription = rig.bus.subscribe(conversation.id)
        await rig.chat(conversation, "帮我设计一个 VQE 方案")
        events = drain(subscription)
        rig.bus.unsubscribe(subscription)

        activity = [e for e in events if e.name == "agent.activity"]
        phases = [e.data["phase"] for e in activity]
        assert phases[0] == "dispatch_started"
        assert phases[-1] == "dispatch_completed"
        assert "reasoning_delta" in phases
        assert "text_delta" in phases
        assert "tool_call" in phases
        # seq 单调且与 SSE 帧 id（event.seq）一致
        seqs = [e.data["seq"] for e in activity]
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
        assert all(e.data["seq"] == e.seq for e in activity)
        # 载荷契约字段：子 Agent 是 algorithm-designer；锚定本会话与消息
        assert {e.data["agent_id"] for e in activity} == {"algorithm-designer"}
        assert all(e.data["conversation_id"] == conversation.id for e in activity)
        assert all(e.data["message_id"] for e in activity)

    async def test_tool_call_activity_carries_tool_payload(self) -> None:
        """tool_call 相位携带 {name, arguments}（arguments 为 JSON 字符串）。"""
        rig = Rig()
        rig.tools.bind_dispatcher(rig.runtime.run_subagent)
        conversation = rig.new_conversation("orchestrator")
        subscription = rig.bus.subscribe(conversation.id)
        await rig.chat(conversation, "设计 VQE")
        events = drain(subscription)
        rig.bus.unsubscribe(subscription)
        tool_frames = [
            e for e in events
            if e.name == "agent.activity" and e.data["phase"] == "tool_call"
        ]
        assert tool_frames, "dispatch 子运行应外显 tool_call"
        emit_frame = next(e for e in tool_frames if e.data["tool"]["name"] == "emit_artifact")
        arguments = json.loads(emit_frame.data["tool"]["arguments"])
        assert arguments["artifact"]["type"] == "circuit"

    async def test_main_run_stream_unaffected(self) -> None:
        """主运行仍走 message.delta/message.completed；子运行不发布
        message.completed（其回复经工具结果回流）。"""
        rig = Rig()
        rig.tools.bind_dispatcher(rig.runtime.run_subagent)
        conversation = rig.new_conversation("orchestrator")
        subscription = rig.bus.subscribe(conversation.id)
        await rig.chat(conversation, "设计 VQE")
        events = drain(subscription)
        rig.bus.unsubscribe(subscription)
        names = [e.name for e in events]
        assert "message.delta" in names
        assert names.count("message.completed") == 1  # 仅主运行一次
        # 主运行与子运行的增量各归各流：agent.activity 的 delta 不出现在
        # message.delta 载荷流之外
        completed = next(e for e in events if e.name == "message.completed")
        assert completed.data["message_id"] != ""


class TestArtifactCreatedImmediacy:
    async def test_emit_artifact_publishes_immediately(self) -> None:
        """emit_artifact 产生即推 artifact.created——订阅队列无需等待即可
        见（同步发布），载荷含归属消息锚点与产物信封。"""
        rig = Rig()
        tools = PlatformTools(
            rig.idgen, rig.tenants, rig.scheduler, rig.tasks,
            rig.registry.snapshot, events=rig.bus,
        )
        context = ToolContext(
            conversation_id="c-9001", tenant_id="demo",
            agent_id="algorithm-designer", message_id="m-9001", run_key="rk-1",
        )
        subscription = rig.bus.subscribe("c-9001")
        payload = json.dumps(
            {"artifact": {"type": "counts", "title": "即时性测试",
                          "payload": default_demo_artifacts()["counts"]}},
            ensure_ascii=False,
        )
        result = json.loads(await tools.execute(context, "emit_artifact", payload))
        # 关键断言：不 await 任何 sleep，事件已在队列（发布是同步的）
        events = drain(subscription)
        rig.bus.unsubscribe(subscription)
        created = [e for e in events if e.name == "artifact.created"]
        assert len(created) == 1
        assert created[0].data["message_id"] == "m-9001"
        assert created[0].data["conversation_id"] == "c-9001"
        assert created[0].data["artifact"]["id"] == result["artifact_id"]
        assert created[0].data["artifact"]["type"] == "counts"
        # 产物仍挂运行上下文（message.completed 全量携带的来源）
        assert len(context.pending_artifacts) == 1

    async def test_created_precedes_completed_and_completed_still_full(self) -> None:
        """装配 events 的完整运行：artifact.created 均先于 message.completed
        （产生即推）；completed 帧仍全量携带全部产物（既有语义不变）。"""
        rig = Rig()
        tools = PlatformTools(
            rig.idgen, rig.tenants, rig.scheduler, rig.tasks,
            rig.registry.snapshot, events=rig.bus,
        )
        runtime = AgentRuntime(
            rig.plugins, lambda model_ref: rig.provider, tools, rig.bus
        )
        conversation = rig.new_conversation("algorithm-designer")
        subscription = rig.bus.subscribe(conversation.id)
        user = rig.append_message(conversation, "user", "设计一个方案")
        assistant = rig.append_message(conversation, "assistant", "")
        await runtime.run(conversation, rig.messages.list(conversation.id)[:-1], assistant)
        events = drain(subscription)
        rig.bus.unsubscribe(subscription)

        created = [e for e in events if e.name == "artifact.created"]
        completed = next(e for e in events if e.name == "message.completed")
        assert len(created) == 2  # 演示剧本 emit×2，各自即时推送
        assert all(e.seq < completed.seq for e in created)
        # completed 仍全量携带，且与即时事件的产物一一对应
        assert [e.data["artifact"]["id"] for e in created] == [
            a["id"] for a in completed.data["artifacts"]
        ]
        assert [a["type"] for a in completed.data["artifacts"]] == ["circuit", "counts"]


class TestDispatchArtifactStreaming:
    async def test_subagent_artifacts_stream_via_created_event(self) -> None:
        """dispatch 子运行中专家的 emit_artifact 同样即时外显（载荷锚定
        父消息），无需等主运行收束。"""
        rig = Rig()
        tools = PlatformTools(
            rig.idgen, rig.tenants, rig.scheduler, rig.tasks,
            rig.registry.snapshot, events=rig.bus,
        )
        runtime = AgentRuntime(
            rig.plugins, lambda model_ref: rig.provider, tools, rig.bus
        )
        tools.bind_dispatcher(runtime.run_subagent)
        conversation = rig.new_conversation("orchestrator")
        subscription = rig.bus.subscribe(conversation.id)
        user = rig.append_message(conversation, "user", "帮我设计一个 VQE 方案")
        assistant = rig.append_message(conversation, "assistant", "")
        await runtime.run(conversation, rig.messages.list(conversation.id)[:-1], assistant)
        events = drain(subscription)
        rig.bus.unsubscribe(subscription)

        created = [e for e in events if e.name == "artifact.created"]
        completed = next(e for e in events if e.name == "message.completed")
        # 子 Agent 的两件产物在 completed 之前已流式到达，锚定父消息
        assert len(created) == 2
        assert all(e.seq < completed.seq for e in created)
        assert all(e.data["message_id"] == assistant.id for e in created)
        # 全局流（无会话）不转发 agent.activity / artifact.created（§7 语义）
        global_events = rig.bus.replay(None, conversation_id=None)
        assert not any(
            e.name in ("agent.activity", "artifact.created") for e in global_events
        )
