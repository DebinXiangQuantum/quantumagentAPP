"""路由汇总（契约 §5 的全部端点）。"""

from fastapi import APIRouter

from qap.api.routers import agents, conversations, events, hardware, health, tasks, tenants

#: 挂载到 /api/v1 的总路由
api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(agents.router)
api_router.include_router(tenants.router)
api_router.include_router(conversations.router)
api_router.include_router(tasks.router)
api_router.include_router(hardware.router)
api_router.include_router(events.router)

__all__ = ["api_router"]
