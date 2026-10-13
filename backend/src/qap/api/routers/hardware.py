"""GET /api/v1/hardware —— 硬件拓扑与分配快照（契约 §5/§4）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["hardware"], dependencies=[Depends(require_tenant)])


@router.get("/hardware")
async def list_hardware(state: AppState = Depends(get_state)) -> dict:
    """全量节点（按 config 顺序）：利用率、容量与活动分配。

    分配里的 ``agent_id`` 回答"哪个 Agent 在用哪块 GPU"（§10 第 4 条）。
    """
    return {"nodes": [node.model_dump() for node in state.nodes.snapshot()]}
