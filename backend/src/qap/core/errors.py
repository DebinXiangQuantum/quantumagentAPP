"""全局错误基类与统一错误码。

所有可预期失败（配置非法、资源不存在、配额超限、provider 故障……）都携带
稳定 `code`，API 层据此映射 HTTP 状态码（见 qap/api/errors.py）；
SSE `error` 事件同样携带 `{code, message}`（契约 §7）。
"""

from __future__ import annotations


class QapError(Exception):
    """平台统一错误基类：`code` 用于日志/SSE/HTTP 的机器可读分类。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def __str__(self) -> str:  # pragma: no cover - 仅为日志可读性
        return f"[{self.code}] {self.message}"


class NotFoundError(QapError):
    """资源不存在；含"存在但属于其他租户"的跨租户隔离场景（一律 404）。"""

    def __init__(self, resource: str, resource_id: str) -> None:
        super().__init__("not_found", f"{resource} not found: {resource_id!r}")


class AuthError(QapError):
    """Bearer Key 缺失/未知（401）或租户被禁用（403）。"""

    def __init__(self, message: str, *, disabled: bool = False) -> None:
        super().__init__("tenant_disabled" if disabled else "unauthorized", message)


class QuotaError(QapError):
    """配额超限（429）。`retry_after_seconds` 进入 Retry-After 响应头。"""

    def __init__(self, message: str, retry_after_seconds: int) -> None:
        super().__init__("quota_exceeded", message)
        if retry_after_seconds < 1:
            raise ValueError("retry_after_seconds must be >= 1 second")
        self.retry_after_seconds = retry_after_seconds


class ValidationFailed(QapError):
    """请求/领域输入校验失败（DAG 非法、artifact 载荷非法、非有限 float 等）。"""

    def __init__(self, message: str) -> None:
        super().__init__("validation_failed", message)


class ProviderError(QapError):
    """LLM Provider 侧故障（非 200、流中断、超时、密钥缺失等）。"""

    def __init__(self, message: str) -> None:
        super().__init__("provider_error", message)


class SchedulingError(QapError):
    """任务编排/调度失败（无可用节点、步骤超时等）。"""

    def __init__(self, message: str) -> None:
        super().__init__("scheduling_error", message)
