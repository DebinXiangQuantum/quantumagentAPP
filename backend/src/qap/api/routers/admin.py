"""管理端点（契约 §5/§8 v1.1）：插件安装生命周期管理。

全部需要租户鉴权（Bearer / ?api_key=，与会话端点一致）。
- ``POST /api/v1/admin/plugins/install`` ``{"source_path"}``：本地目录 →
  复制到 ``agents.plugins_dir`` 并注册（201）；重名 409；清单缺失/入口
  无法导入 422 带原因；
- ``GET /api/v1/admin/plugins``：builtin + installed + enabled + broken 原因；
- ``PUT /api/v1/admin/plugins/{id}`` ``{"enabled": bool}``：启停并持久化
  config.local.toml ``[agents.plugin_state]``；
- ``DELETE /api/v1/admin/plugins/{id}``：卸载目录 + 清状态；builtin 409。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel, ConfigDict, Field

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.tenancy.service import TenantContext

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_tenant)])


class InstallPluginRequest(BaseModel):
    """POST …/plugins/install 请求体。"""

    model_config = ConfigDict(extra="forbid")

    source_path: str = Field(min_length=1)


class PluginEnableRequest(BaseModel):
    """PUT …/plugins/{id} 请求体。"""

    model_config = ConfigDict(extra="forbid")

    enabled: bool


@router.post("/plugins/install", status_code=status.HTTP_201_CREATED)
async def install_plugin(
    payload: InstallPluginRequest,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """安装插件（来源目录校验 → 复制 → 注册并刷新 orchestrator 专家清单）。"""
    return state.plugin_manager.install(payload.source_path)


@router.get("/plugins")
async def list_plugins(
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """全部插件的管理视图（含 broken 原因；密钥无关，无脱敏需求）。"""
    return {"plugins": state.plugin_manager.list_plugins()}


@router.put("/plugins/{plugin_id}")
async def set_plugin_enabled(
    plugin_id: str,
    payload: PluginEnableRequest,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """启停插件；状态持久化到 config.local.toml（builtin 亦可启停）。"""
    return state.plugin_manager.set_enabled(plugin_id, payload.enabled)


@router.delete("/plugins/{plugin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_plugin(
    plugin_id: str,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> Response:
    """卸载已安装插件（删目录 + 清持久化状态）；builtin → 409。"""
    state.plugin_manager.uninstall(plugin_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
