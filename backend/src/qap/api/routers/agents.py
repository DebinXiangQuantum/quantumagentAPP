"""GET /api/v1/agents —— 已注册 Agent 插件清单（契约 §5/§4 AgentInfo）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["agents"], dependencies=[Depends(require_tenant)])


@router.get("/agents")
async def list_agents(state: AppState = Depends(get_state)) -> list[dict]:
    """全部已注册插件的 AgentInfo（按注册序：algorithm-designer 等）。"""
    return [info.model_dump() for info in state.plugins.list()]
