"""QapError → HTTP 状态码映射与 JSON 错误体（契约 §5 错误语义）。

映射表（错误码 → 状态码）：
- ``unauthorized`` → 401；``tenant_disabled`` → 403
- ``not_found`` → 404（含跨租户访问：与不存在同语义）
- ``quota_exceeded`` → 429 + ``Retry-After`` 头（秒）
- ``validation_failed`` → 422
- ``conflict`` → 409（重复安装/删除基底渠道/卸载内置插件）
- 其余（provider/scheduling/内部）→ 500（不向客户端泄露内部细节）
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from qap.core.errors import QapError

#: 错误码 → HTTP 状态码（未列出的码一律 500）
_STATUS_BY_CODE = {
    "unauthorized": 401,
    "tenant_disabled": 403,
    "not_found": 404,
    "conflict": 409,
    "quota_exceeded": 429,
    "validation_failed": 422,
}


async def qap_error_handler(request: Request, exc: QapError) -> JSONResponse:
    """FastAPI 异常处理器：统一 JSON 体 ``{"error": {"code", "message"}}``。"""
    status = _STATUS_BY_CODE.get(exc.code, 500)
    headers: dict[str, str] | None = None
    if status == 429 and getattr(exc, "retry_after_seconds", None):
        headers = {"Retry-After": str(exc.retry_after_seconds)}
    return JSONResponse(
        status_code=status,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers=headers,
    )
