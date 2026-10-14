"""GET /api/v1/models —— 模型选择器列表（契约 §5 v1.3）。

与 ``/admin/models`` 的区别：本端点**任意已鉴权租户可读**（普通用户的输入区
模型下拉即此数据源），只暴露选择所需字段——不含 base_url/api_key_env/timeout
等管理细节。管理编辑（PUT/DELETE、完整字段）仍走 ``/admin/models`` 且仅
admin 角色（§5 v1.2 权限）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.core.config import ModelConfig
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["models"], dependencies=[Depends(require_tenant)])


class ModelSummary(BaseModel):
    """选择器条目：ref/provider/model/default_thinking/has_api_key（脱敏）。"""

    ref: str
    provider: str
    model: str
    default_thinking: str
    has_api_key: bool


def _summary_view(state: AppState, ref: str, entry: ModelConfig) -> ModelSummary:
    """ModelConfig → 选择器视图（复用管理端的密钥解析语义，不外泄细节）。"""
    return ModelSummary(
        ref=ref,
        provider=entry.provider,
        model=entry.model,
        default_thinking=entry.default_thinking,
        has_api_key=bool(state.config.resolve_api_key(ref)),
    )


@router.get("/models")
async def list_selector_models(
    _tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """全部渠道的选择器视图（按配置序）。"""
    return {
        "models": [
            _summary_view(state, ref, entry).model_dump()
            for ref, entry in state.config.models.items()
        ]
    }
