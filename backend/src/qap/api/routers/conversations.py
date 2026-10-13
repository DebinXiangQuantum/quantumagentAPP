"""会话路由：创建/查询/发消息/会话 SSE 流（契约 §5）。

``POST …/messages`` 语义（契约 §5）：立即落库用户消息并返回 202
``{"message_id", "run_id"}``；message_id 是**预创建的 assistant 消息** id
（增量归它），Agent 运行异步执行，产物经会话 SSE 推送。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from qap.api.deps import get_state, require_tenant
from qap.api.sse import event_stream
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["conversations"], dependencies=[Depends(require_tenant)])


class CreateConversationRequest(BaseModel):
    """POST /conversations 请求体。"""

    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1)
    title: str = ""


class PostMessageRequest(BaseModel):
    """POST …/messages 请求体（畸形体由 FastAPI 转 422）。"""

    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1)


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
    """创建会话；agent_id 未注册 → 404（契约 §5 资源不存在语义）。"""
    state.plugins.get(payload.agent_id)  # 未知 agent → NotFoundError → 404
    conversation = state.new_conversation(payload.agent_id, payload.title, tenant.tenant_id)
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
    """落库用户消息并异步启动 Agent 运行（配额超限 → 429 + Retry-After）。"""
    conversation = state.conversations.get(conversation_id, tenant.tenant_id)
    state.tenants.check_message_quota(tenant.tenant_id)
    state.tenants.record_message(tenant.tenant_id)

    user_message = state.new_message(
        conversation.id, "user", payload.content, conversation.agent_id
    )
    state.messages.add(user_message)
    # 预创建空 assistant 消息：SSE 增量归属（契约 §5 message_id 语义）
    assistant = state.new_message(conversation.id, "assistant", "", conversation.agent_id)
    state.messages.add(assistant)
    run_id = state.idgen.next("run")
    history = [m for m in state.messages.list(conversation.id) if m.id != assistant.id]
    state.spawn_run(
        run_id,
        state.runtime.run(conversation, history, assistant),
    )
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
