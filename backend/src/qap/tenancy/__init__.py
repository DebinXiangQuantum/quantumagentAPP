"""tenancy —— 租户注册表、API Key 鉴权与配额（契约 §5）。"""

from qap.tenancy.service import TenantContext, TenantService

__all__ = ["TenantContext", "TenantService"]
