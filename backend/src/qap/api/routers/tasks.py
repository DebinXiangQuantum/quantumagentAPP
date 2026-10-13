"""GET /api/v1/tasks —— 任务查询（契约 §5）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["tasks"], dependencies=[Depends(require_tenant)])


@router.get("/tasks")
async def list_tasks(
    conversation_id: str | None = Query(default=None),
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> list[dict]:
    """当前租户的任务列表（最新在前；可按 conversation_id 过滤）。

    注意：任务对象由调度器就地更新，返回的是查询时刻的快照。
    """
    tasks = state.tasks.list_for_tenant(tenant.tenant_id, conversation_id)
    return [task.model_dump() for task in tasks]


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """单个任务详情；他租任务与不存在同语义 404。"""
    task = state.tasks.get(task_id, tenant.tenant_id)
    return task.model_dump()
