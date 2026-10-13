"""GET /api/v1/events —— 全局 SSE 流（task/hardware 事件，契约 §5/§7）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from qap.api.deps import get_state, require_tenant
from qap.api.sse import event_stream
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["events"], dependencies=[Depends(require_tenant)])


@router.get("/events")
async def global_events(
    after: int | None = Query(default=None, ge=0),
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> StreamingResponse:
    """全局事件流：仅 task.updated / hardware.updated（过滤在 EventBus）。"""
    subscription = state.events.subscribe(None)  # 先订阅…
    replayed = state.events.replay(after, conversation_id=None)  # …再回放（重叠由 seq 去重）
    return StreamingResponse(
        event_stream(state.events, subscription, replayed),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
