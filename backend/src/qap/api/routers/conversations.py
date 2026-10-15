"""会话路由：创建/查询/发消息/会话 SSE 流（契约 §5）。

``POST …/messages`` 语义（契约 §5）：立即落库用户消息并返回 202
``{"message_id", "run_id"}``；message_id 是**预创建的 assistant 消息** id
（增量归它），Agent 运行异步执行，产物经会话 SSE 推送。
"""

from __future__ import annotations

from typing import Any

from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from qap.api.deps import get_state, require_tenant
from qap.api.sse import event_stream
from qap.api.state import AppState
from qap.core.errors import ValidationFailed
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["conversations"], dependencies=[Depends(require_tenant)])


class CreateConversationRequest(BaseModel):
    """POST /conversations 请求体。

    ``agent_id``（v1.1 §4）可选：缺省绑定内置编排 Agent ``orchestrator``，
    由其按任务自主 dispatch_agent 到领域专家。
    """

    model_config = ConfigDict(extra="forbid")

    agent_id: str | None = Field(default=None, min_length=1)
    title: str = ""


class PostMessageRequest(BaseModel):
    """POST …/messages 请求体（畸形体由 FastAPI 转 422）。

    v1.1（契约 §5）：``model_ref`` 覆盖本条消息使用的渠道（须存在于渠道
    池，未知值在路由层 422）；``thinking_level`` 覆盖思考程度（枚举校验
    交给 Literal → FastAPI 422）。两者优先级高于渠道 default_thinking。
    """

    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1)
    model_ref: str | None = Field(default=None, min_length=1)
    thinking_level: Literal["off", "low", "high", "max"] | None = None
    #: v1.3：随消息引用的附件（须属于本会话与本租户；未知/跨会话 → 422）
    attachment_ids: list[str] = Field(default_factory=list)


@router.get("/conversations")
async def list_conversations(
    limit: int = Query(default=50, ge=1, le=200),
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> list[dict]:
    """当前租户的会话列表（最新在前）。"""
    conversations = state.conversations.list_for_tenant(tenant.tenant_id, limit)
    return [conversation.model_dump() for conversation in conversations]


@router.post("/conversations", status_code=201)
async def create_conversation(
    payload: CreateConversationRequest,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """创建会话；agent_id 缺省 = orchestrator（v1.1），未知值 → 404。"""
    agent_id = payload.agent_id or "orchestrator"
    state.plugins.get(agent_id)  # 未知 agent → NotFoundError → 404
    conversation = state.new_conversation(agent_id, payload.title, tenant.tenant_id)
    state.conversations.add(conversation)
    return conversation.model_dump()


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """会话详情 + 全部消息（含 artifacts）。"""
    conversation = state.conversations.get(conversation_id, tenant.tenant_id)
    messages = state.messages.list(conversation_id)
    payload: dict[str, Any] = conversation.model_dump()
    payload["messages"] = [message.model_dump() for message in messages]
    return payload


@router.post("/conversations/{conversation_id}/messages", status_code=202)
async def post_message(
    conversation_id: str,
    payload: PostMessageRequest,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """落库用户消息并异步启动 Agent 运行（配额超限 → 429 + Retry-After）。

    v1.1：``model_ref`` 必须存在于渠道池（未知 → 422，契约 §5）；
    ``thinking_level`` 枚举校验由请求模型完成（非法 → 422）。
    """
    conversation = state.conversations.get(conversation_id, tenant.tenant_id)
    if payload.model_ref is not None and payload.model_ref not in state.config.models:
        raise ValidationFailed(
            f"unknown model_ref {payload.model_ref!r}; "
            f"available: {sorted(state.config.models)}"
        )
    # v1.3：附件引用校验（未知/跨会话/跨租户 → 422），元数据落到 user 消息
    attachment_records = [
        state.attachments.get_for_conversation(
            attachment_id, conversation.id, tenant.tenant_id
        )
        for attachment_id in payload.attachment_ids
    ]
    state.tenants.check_message_quota(tenant.tenant_id)
    state.tenants.record_message(tenant.tenant_id)

    user_message = state.new_message(
        conversation.id, "user", payload.content, conversation.agent_id
    )
    user_message.attachments = [record.meta() for record in attachment_records]
    state.messages.add(user_message)
    # 预创建空 assistant 消息：SSE 增量归属（契约 §5 message_id 语义）
    assistant = state.new_message(conversation.id, "assistant", "", conversation.agent_id)
    state.messages.add(assistant)
    run_id = state.idgen.next("run")
    history = [m for m in state.messages.list(conversation.id) if m.id != assistant.id]
    async def _run_and_persist() -> None:
        """执行 Agent 运行并将最终消息状态持久化（v1.9 SQLite 兼容）。

        内存版 Store 按引用共享（就地修改即生效）；SQLite 版需要显式
        update() 落库——runtime.run() 修改 assistant 后由此处统一持久化。
        """
        await state.runtime.run(
            conversation,
            history,
            assistant,
            model_ref=payload.model_ref,
            thinking_level=payload.thinking_level,
        )
        state.messages.update(assistant)  # content/reasoning/artifacts 落库

    state.spawn_run(run_id, _run_and_persist())
    return {"message_id": assistant.id, "run_id": run_id}


@router.get("/conversations/{conversation_id}/stream")
async def conversation_stream(
    conversation_id: str,
    after: int | None = Query(default=None, ge=0),
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> StreamingResponse:
    """会话 SSE 流：message.* / task.updated / error + 全局 hardware.updated。

    ``?after=<seq>`` 断线续传：先回放缓存（最近 1024 条）再跟随实时。
    """
    state.conversations.get(conversation_id, tenant.tenant_id)  # 404 语义
    subscription = state.events.subscribe(conversation_id)  # 先订阅…
    replayed = state.events.replay(after, conversation_id=conversation_id)  # …再回放
    return StreamingResponse(
        event_stream(state.events, subscription, replayed),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
