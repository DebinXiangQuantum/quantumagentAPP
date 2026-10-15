"""Agent 运行时：Provider 流式 → 工具循环 → SSE（契约 §8 Runtime 工具循环）。

循环（每轮）：
``system_prompt + 历史 → provider.stream`` —— ThoughtDelta 实时进 SSE
``message.reasoning`` 并累加 ``Message.reasoning``（v1.1：思考先行），
TextDelta 实时进 SSE ``message.delta``；ToolCall 交 :class:`PlatformTools`
执行并把结构化结果回填历史（assistant.tool_calls + tool 消息），直至纯
文本轮或安全上限。

思考程度（v1.1 §9）：``run()`` 接受可选的 ``thinking_level``（消息级），
与 ``model_ref``（消息级渠道覆盖）一起解析——优先级：消息级
``thinking_level`` > 所选渠道 ``default_thinking``（缺省 "high"）。

终止语义：
- 纯文本轮（无工具调用）→ 正常收束；
- ProviderErrorEvent → 发布 SSE ``error`` 事件，以**已积累的部分文本**收束
  （前端拿到 message.completed 归属与闭合，而非悬空增量）；
- 轮次达到 :data:`MAX_TOOL_LOOP_TURNS` → 强制收束（防剧本/模型死循环）。

收束统一动作：把 ``ToolContext.pending_artifacts`` 落到 assistant 消息，
发布 ``message.completed``（载荷含 artifacts 与 reasoning 全文，契约 §7）。
"""

from __future__ import annotations

from typing import Callable, Sequence

from qap.agents.plugins import AgentPlugin, PluginRegistry
from qap.agents.providers.base import (
    CompletionRequest,
    LLMProvider,
    ProviderErrorEvent,
    TextDelta,
    ThoughtDelta,
    ToolCall,
    ToolCallRecord,
    TurnCompleted,
)
from qap.agents.tools import PlatformTools, ToolContext
from qap.core.errors import NotFoundError
from qap.domain.models import Conversation, Message
from qap.events.bus import EventBus

#: 工具循环安全上限（轮）：脚本化测试替身需要 2 轮；真实模型偶发多轮工具
#: 工具循环安全上限（防死循环）。v1.6 调研：真实真机工作流（编排 dispatch +
#: 多机提交 + query_task_results 轮询 + 最终分析）在 8 轮内收不住——真实
#: 联调实测一次 QNN 全流程需 12+ 轮；24 轮兼顾安全与真实工作流长度。
MAX_TOOL_LOOP_TURNS = 24
#: dispatch_agent 嵌套深度上限（契约 §8 v1.1：深度=1，子 Agent 不可再分派）
MAX_DISPATCH_DEPTH = 1


class AgentRuntime:
    """一次对话运行的执行器（无内部状态，可并发复用）。"""

    def __init__(
        self,
        plugins: PluginRegistry,
        provider_for: Callable[[str], LLMProvider],
        tools: PlatformTools,
        events: EventBus,
        *,
        default_thinking_for: Callable[[str], str] | None = None,
        attachment_resolver: Callable[[Message], Sequence] | None = None,
        model_ref_alias: Callable[[str], str] | None = None,
    ) -> None:
        """``default_thinking_for(model_ref)`` 返回渠道默认思考程度（v1.1）。

        缺省闭包返回 "high"（契约 §9 优先级末端）；组装根注入
        ``config.models[ref].default_thinking`` 的真实查表。
        ``attachment_resolver(message)``（v1.3 §5）：把带附件的 user 消息
        解析为 ``AttachmentPart`` 序列（text 截断 200k / image base64），
        随中间表示进入 provider；None = 本部署不支持附件注入。
        """
        self._plugins = plugins
        self._provider_for = provider_for
        self._tools = tools
        self._events = events
        self._default_thinking_for = default_thinking_for or (lambda _ref: "high")
        self._attachment_resolver = attachment_resolver
        # v1.4 别名：插件绑定 model_ref == "default" → agents.default_model_ref
        # （真实联调缺陷修复：内置插件字面指向演示渠道会让 dispatch 专家
        #  产出模板回复；别名只作用于插件绑定，消息级覆盖保持字面）。
        self._model_ref_alias = model_ref_alias or (lambda ref: ref)

    # ---------- 入口 ----------

    async def run(
        self,
        conversation: Conversation,
        history: Sequence[Message],
        assistant: Message,
        *,
        model_ref: str | None = None,
        thinking_level: str | None = None,
    ) -> Message:
        """执行一轮 Agent 回复（history 含触发的用户消息）。

        :param assistant: 预创建的空 assistant 消息（API 层 202 已返回其 id）；
            本方法就地填充 content/reasoning/artifacts 并返回同一对象。
        :param model_ref: 消息级渠道覆盖（契约 §5 v1.1）；None 用插件绑定渠道。
        :param thinking_level: 消息级思考程度；None 用渠道 default_thinking。
        :raises NotFoundError: 会话绑定的 agent 未注册（API 层 404/422）。
        """
        plugin = self._plugins.get(conversation.agent_id)
        # 消息级覆盖优先且保持字面渠道语义；否则插件绑定经别名解析
        effective_ref = model_ref or self._model_ref_alias(plugin.model_ref)
        provider = self._provider_for(effective_ref)
        level = thinking_level or self._default_thinking_for(effective_ref)
        context = ToolContext(
            conversation_id=conversation.id,
            tenant_id=conversation.tenant_id,
            agent_id=plugin.id,
            message_id=assistant.id,
            run_key=f"{conversation.id}:{assistant.id}",
        )
        await self._drive(
            conversation, plugin, assistant, context, provider, list(history), level
        )
        return assistant

    async def run_subagent(
        self, parent: ToolContext, agent_id: str, instruction: str
    ) -> dict:
        """执行一次 dispatch_agent 子运行（契约 §8 v1.1，深度=1）。

        以目标专家的 system_prompt+tools 跑完整工具循环（不向 SSE 发布
        增量——回复文本作为工具结果回流 orchestrator）；专家的
        emit_artifact/submit_task 经共享的 ``pending_artifacts`` 与上下文
        归属当前会话与消息。返回结构化 dict（错误亦然，模型可自纠错）。
        """
        if parent.dispatch_depth >= MAX_DISPATCH_DEPTH:
            return {
                "error": "dispatch_denied",
                "message": "dispatch nesting depth exceeded (max 1)",
            }
        try:
            plugin = self._plugins.get(agent_id)
        except NotFoundError:
            return {
                "error": "agent_not_found",
                "message": f"no registered agent with id {agent_id!r}",
            }
        resolved_ref = self._model_ref_alias(plugin.model_ref)
        provider = self._provider_for(resolved_ref)
        level = self._default_thinking_for(resolved_ref)
        from qap.core.clock import utcnow_iso
        from qap.domain.models import Message as MessageModel

        # 子运行的"影子 assistant"：仅承载累积文本/思考，不落库不出 SSE
        shadow = MessageModel(
            id=parent.message_id,
            conversation_id=parent.conversation_id,
            role="assistant",
            content="",
            agent_id=plugin.id,
            created_at=utcnow_iso(),
        )
        sub_context = ToolContext(
            conversation_id=parent.conversation_id,
            tenant_id=parent.tenant_id,
            agent_id=plugin.id,
            message_id=parent.message_id,
            run_key=f"{parent.run_key}:dispatch:{plugin.id}",
            dispatch_depth=parent.dispatch_depth + 1,
        )
        # 产物归属：子 Agent 的 emit_artifact 直接进父消息的产物列表
        sub_context.pending_artifacts = parent.pending_artifacts
        from qap.domain.models import Conversation as ConversationModel

        carrier = ConversationModel(
            id=parent.conversation_id,
            title="",
            agent_id=plugin.id,
            tenant_id=parent.tenant_id,
            created_at=shadow.created_at,
        )
        history = [type(shadow)(id="m-0", conversation_id=carrier.id,
                                role="user", content=instruction,
                                agent_id=plugin.id, created_at=shadow.created_at)]
        # v1.4 实时外显：子运行全程映射为 agent.activity（契约 §7）——
        # dispatch_started → reasoning/text/tool 增量 → dispatch_completed
        # （成败都收束；正文增量不进 message.delta，避免与父运行混淆）。
        self._publish_activity(
            parent.conversation_id, parent.message_id, plugin.id, "dispatch_started"
        )
        try:
            shadow, failure = await self._drive(
                carrier, plugin, shadow, sub_context, provider, history, level,
                stream_to_sse=False, activity=True,
            )
        finally:
            self._publish_activity(
                parent.conversation_id, parent.message_id, plugin.id,
                "dispatch_completed",
            )
        if failure is not None:
            return {"error": "provider_error", "message": failure}
        return {"reply": shadow.content, "agent_id": plugin.id}

    # ---------- 主循环（会话运行与子运行共用骨架） ----------

    async def _drive(
        self,
        conversation: Conversation,
        plugin: AgentPlugin,
        assistant: Message,
        context: ToolContext,
        provider: LLMProvider,
        history: Sequence[Message],
        thinking_level: str,
        *,
        stream_to_sse: bool = True,
        activity: bool = False,
    ) -> tuple[Message, str | None]:
        """工具循环骨架；``stream_to_sse=False`` 为 dispatch 子运行（§8）。

        子运行与主运行的差异：不向 SSE 发布增量与完成事件（其回复作为
        工具结果回流 orchestrator）、不落库（无独立 assistant 消息语义）；
        provider 故障仍发布 SSE ``error``（诚实遥测）。
        ``activity=True``（v1.4 §7）：子运行的 ProviderEvent 逐条映射为
        ``agent.activity``（phase= reasoning_delta/text_delta/tool_call）。

        :returns: (累积后的 assistant, 失败消息或 None)。
        """
        # 中间表示历史（含本轮用户消息；跳过无文本内容的历史噪音）
        turns: list[dict] = [
            self._turn_for(message) for message in history if message.content
        ]
        text_buffer: list[str] = []
        reasoning_buffer: list[str] = []
        tool_specs = self._combined_tool_specs(plugin)
        failure: str | None = None
        try:
            for turn_index in range(MAX_TOOL_LOOP_TURNS):
                request = CompletionRequest(
                    model=plugin.model_ref,
                    messages=list(turns),
                    system=plugin.system_prompt,
                    tools=tool_specs,
                    metadata={"run_key": context.run_key, "agent_id": plugin.id},
                    thinking_level=thinking_level,  # type: ignore[arg-type]
                )
                calls, stop_reason, failure = await self._stream_turn(
                    conversation, assistant, context, provider, request,
                    text_buffer, reasoning_buffer, stream_to_sse, activity,
                )
                if failure is not None or not calls:
                    break  # 出错或纯文本轮 → 收束
                # 回填：assistant 工具调用记录 + 各工具结果
                turns.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": calls,
                    }
                )
                for record in calls:
                    result = await self._tools.execute(context, record.name, record.arguments)
                    turns.append(
                        {
                            "role": "tool",
                            "tool_call_id": record.id,
                            "name": record.name,
                            "content": result,
                        }
                    )
            else:  # for-else：轮次耗尽
                text_buffer.append("（已达工具循环轮次上限，回复在此收束。）")
        finally:
            self._finalize(
                conversation, assistant, context,
                text_buffer, reasoning_buffer, failure,
                stream_to_sse=stream_to_sse,
            )
        return assistant, failure

    # ---------- 单轮流处理 ----------

    async def _stream_turn(
        self,
        conversation: Conversation,
        assistant: Message,
        context: ToolContext,
        provider: LLMProvider,
        request: CompletionRequest,
        text_buffer: list[str],
        reasoning_buffer: list[str],
        stream_to_sse: bool,
        activity: bool = False,
    ) -> tuple[list[ToolCallRecord], str | None, str | None]:
        """消费一次 provider 流。

        ``activity=True``（v1.4）：dispatch 子运行期把 ThoughtDelta/TextDelta/
        ToolCall 逐条映射为 ``agent.activity``（phase= reasoning_delta/
        text_delta/tool_call；正文不进 message.delta，与父运行流不混淆）。

        :returns: (本轮工具调用记录, stop_reason, 失败消息或 None)。
        """
        calls: list[ToolCallRecord] = []
        stop_reason: str | None = None
        failure: str | None = None
        async for event in provider.stream(request):
            if isinstance(event, ThoughtDelta):
                reasoning_buffer.append(event.text)
                assistant.reasoning = "".join(reasoning_buffer)
                if stream_to_sse:
                    self._events.publish(
                        "message.reasoning",
                        {
                            "conversation_id": conversation.id,
                            "message_id": assistant.id,
                            "delta": event.text,
                        },
                        conversation_id=conversation.id,
                    )
                elif activity:
                    self._publish_activity(
                        conversation.id, assistant.id, context.agent_id,
                        "reasoning_delta", delta=event.text,
                    )
            elif isinstance(event, TextDelta):
                text_buffer.append(event.text)
                assistant.content = "".join(text_buffer)
                if stream_to_sse:
                    self._events.publish(
                        "message.delta",
                        {
                            "conversation_id": conversation.id,
                            "message_id": assistant.id,
                            "delta": event.text,
                        },
                        conversation_id=conversation.id,
                    )
                elif activity:
                    self._publish_activity(
                        conversation.id, assistant.id, context.agent_id,
                        "text_delta", delta=event.text,
                    )
            elif isinstance(event, ToolCall):
                calls.append(
                    ToolCallRecord(
                        id=f"call-{context.run_key}-{len(calls)}",
                        name=event.name,
                        arguments=event.arguments,
                    )
                )
                if activity and not stream_to_sse:
                    self._publish_activity(
                        conversation.id, assistant.id, context.agent_id,
                        "tool_call",
                        tool={"name": event.name, "arguments": event.arguments},
                    )
            elif isinstance(event, ProviderErrorEvent):
                failure = event.message
                # 契约 §7：provider 故障（超时等）走 error 事件
                self._events.publish(
                    "error",
                    {"code": "provider_error", "message": event.message},
                    conversation_id=conversation.id,
                )
            elif isinstance(event, TurnCompleted):
                stop_reason = event.stop_reason
        return calls, stop_reason, failure

    def _publish_activity(
        self,
        conversation_id: str,
        message_id: str,
        agent_id: str,
        phase: str,
        *,
        delta: str | None = None,
        tool: dict | None = None,
    ) -> None:
        """发布一条 ``agent.activity``（契约 §7 v1.4；seq 由总线注入）。"""
        payload: dict = {
            "conversation_id": conversation_id,
            "message_id": message_id,
            "agent_id": agent_id,
            "phase": phase,
        }
        if delta is not None:
            payload["delta"] = delta
        if tool is not None:
            payload["tool"] = tool
        self._events.publish("agent.activity", payload, conversation_id=conversation_id)

    # ---------- 收束 ----------

    def _finalize(
        self,
        conversation: Conversation,
        assistant: Message,
        context: ToolContext,
        text_buffer: list[str],
        reasoning_buffer: list[str],
        failure: str | None,
        *,
        stream_to_sse: bool = True,
    ) -> None:
        """统一收束：落 content/reasoning/artifacts；主运行发布
        ``message.completed``（子运行不发布——其回复经工具结果回流）。"""
        assistant.content = "".join(text_buffer)
        assistant.reasoning = "".join(reasoning_buffer)
        assistant.artifacts = list(context.pending_artifacts)
        if not stream_to_sse:
            return
        self._events.publish(
            "message.completed",
            {
                "conversation_id": conversation.id,
                "message_id": assistant.id,
                "artifacts": [a.model_dump() for a in assistant.artifacts],
                "reasoning": assistant.reasoning,
            },
            conversation_id=conversation.id,
        )

    # ---------- 内部 ----------

    def _combined_tool_specs(self, plugin: AgentPlugin) -> list:
        """平台工具 + 插件领域工具的合并声明（平台工具在前，稳定次序）。"""
        specs: list = list(PlatformTools.specs())
        specs.extend(
            {"name": t.name, "description": t.description, "parameters": t.parameters}
            for t in plugin.tools
        )
        return specs

    def _turn_for(self, message: Message) -> dict:
        """历史消息 → provider 中间表示；带附件的 user 消息附加 AttachmentPart
        序列（v1.3：provider 负责把 text 注入上下文 / image 转 wire 格式；
        resolver 缺失或无附件时与既有行为完全一致）。"""
        turn = {"role": message.role, "content": message.content}
        if (
            message.role == "user"
            and message.attachments
            and self._attachment_resolver is not None
        ):
            parts = list(self._attachment_resolver(message))
            if parts:
                turn["attachments"] = parts
        return turn
