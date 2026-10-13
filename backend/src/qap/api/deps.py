"""请求级依赖：状态容器访问与 Bearer 鉴权（契约 §5）。"""

from __future__ import annotations

from fastapi import Request

from qap.api.state import AppState
from qap.core.errors import AuthError
from qap.tenancy.service import TenantContext

#: Authorization 头的方案前缀（仅接受大小写敏感的 "Bearer"，与主流网关一致）
_BEARER_PREFIX = "Bearer "


def get_state(request: Request) -> AppState:
    """取应用级状态容器（main.create_app 挂在 app.state.qap）。"""
    state: AppState | None = getattr(request.app.state, "qap", None)
    if state is None:  # pragma: no cover - 组装错误保护
        raise RuntimeError("AppState not initialised on app.state.qap")
    return state


def require_tenant(request: Request) -> TenantContext:
    """Bearer API Key → TenantContext（401/403 语义在 TenantService）。

    除 /health 外所有路由都依赖本函数（契约 §5）。
    """
    header = request.headers.get("authorization", "")
    if not header.startswith(_BEARER_PREFIX):
        raise AuthError("Authorization header must be 'Bearer <api_key>'")
    api_key = header[len(_BEARER_PREFIX):].strip()
    state = get_state(request)
    return state.tenants.authenticate(api_key)
