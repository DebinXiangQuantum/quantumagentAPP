"""GET /api/v1/tenants/me —— 当前租户信息与用量/配额（契约 §5）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["tenants"], dependencies=[Depends(require_tenant)])


@router.get("/tenants/me")
async def tenant_me(
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """鉴权租户的用量视图（今日消息数/活动任务数/两项配额）。"""
    return state.tenants.usage_snapshot(tenant.tenant_id)
