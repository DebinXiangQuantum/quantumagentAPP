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
    """API Key → TenantContext（401/403 语义在 TenantService）。

    鉴权取值顺序（契约 §5 修订）：
    1. ``Authorization: Bearer <api_key>`` 头（权威，REST 客户端标准路径）；
    2. 头缺失时回退 ``?api_key=`` 查询参数——浏览器 ``EventSource`` 不支持
       自定义请求头（MDN），SSE 订阅只能走查询参数。
    头存在但不合法时**不会**回退到查询参数（避免坏头被参数"抢救"造成
    鉴权来源歧义）。

    已知权衡（原型接受，待生产收紧）：查询参数可能进入访问日志；生产部署
    应换用一次性 ticket 或 Cookie 方案，见 docs/ARCHITECTURE.md §13。
    """
    header = request.headers.get("authorization", "")
    if header.startswith(_BEARER_PREFIX):
        api_key = header[len(_BEARER_PREFIX):].strip()
    elif not header:
        api_key = request.query_params.get("api_key", "")
    else:
        # 存在 Authorization 头但非 Bearer 方案 → 直接拒绝
        raise AuthError("Authorization header must be 'Bearer <api_key>'")
    if not api_key:
        raise AuthError(
            "Missing API key: use 'Authorization: Bearer <api_key>' header"
            " or '?api_key=' query parameter (SSE/EventSource)"
        )
    state = get_state(request)
    return state.tenants.authenticate(api_key)
