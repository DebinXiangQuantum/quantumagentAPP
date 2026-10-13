"""GET /api/v1/health —— 唯一免鉴权端点（存活探针，契约 §5）。"""

from __future__ import annotations

from fastapi import APIRouter

import qap

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    """存活检查：版本号来自包元数据（pyproject 单一来源）。"""
    return {"status": "ok", "version": qap.__version__}
