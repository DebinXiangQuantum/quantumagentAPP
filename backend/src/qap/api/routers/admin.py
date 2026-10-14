"""管理端点（契约 §5/§8 v1.1 + §5 v1.2 管理权限）：渠道池 CRUD +
插件安装生命周期管理。

全部需要租户鉴权（Bearer / ?api_key=，与会话端点一致）且
**role = admin**（v1.2 守卫 ``require_admin``：非 admin → 403
``{"error":{"code":"forbidden"}}``，守卫先于端点自身校验；前端隐藏
管理分区只是 UX，强制力在此）。

渠道池（§5 v1.1，密钥脱敏）：
- ``GET /api/v1/admin/models`` → ``{"models": ModelChannel[]}``
  （``has_api_key`` = 环境变量非空或本地文件内联；**绝不回传密钥明文**）；
- ``PUT /api/v1/admin/models/{ref}``：更新或创建渠道并持久化
  config.local.toml；``api_key_inline`` 只写本地文件，响应只体现
  has_api_key；provider/default_thinking 非法 → 422；
- ``DELETE /api/v1/admin/models/{ref}``：仅可删本地覆盖渠道（204）；
  基底渠道（config.toml）或仍被 agents/插件引用 → 409。

插件（§8 v1.1）：
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

from qap.api.deps import get_state, require_admin
from qap.api.state import AppState
from qap.core.config import ModelConfig
from qap.core.errors import ConflictError, NotFoundError
from qap.tenancy.service import TenantContext

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


# ---------- 请求/响应模型 ----------

class ModelChannelInput(BaseModel):
    """PUT …/admin/models/{ref} 请求体（契约 §5 ModelChannelInput）。

    ``api_key_inline``：明文密钥——只写 config.local.toml（gitignored），
    响应与 GET 中只体现为 ``has_api_key: true``。
    """

    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    base_url: str | None = None
    api_key_env: str | None = None
    api_key_inline: str | None = None
    timeout_seconds: float = Field(default=120.0, gt=0)
    default_thinking: str = "high"


class ModelChannelOut(BaseModel):
    """GET/PUT 响应体（密钥脱敏：无 api_key_inline 字段）。"""

    model_config = ConfigDict(extra="forbid")

    ref: str
    provider: str
    model: str
    base_url: str | None
    api_key_env: str | None
    has_api_key: bool
    default_thinking: str
    timeout_seconds: float


class InstallPluginRequest(BaseModel):
    """POST …/plugins/install 请求体。"""

    model_config = ConfigDict(extra="forbid")

    source_path: str = Field(min_length=1)


class PluginEnableRequest(BaseModel):
    """PUT …/plugins/{id} 请求体。"""

    model_config = ConfigDict(extra="forbid")

    enabled: bool


# ---------- 渠道池 ----------

def _channel_view(state: AppState, ref: str, entry: ModelConfig) -> ModelChannelOut:
    """ModelConfig → 脱敏视图（has_api_key = 内联或环境变量可用）。"""
    return ModelChannelOut(
        ref=ref,
        provider=entry.provider,
        model=entry.model,
        base_url=entry.base_url,
        api_key_env=entry.api_key_env,
        has_api_key=bool(state.config.resolve_api_key(ref)),
        default_thinking=entry.default_thinking,
        timeout_seconds=entry.timeout_seconds,
    )


def _referencing_agents(state: AppState, ref: str) -> list[str]:
    """仍引用该渠道的 agents（悬空引用防护：default_model_ref/builtin/插件）。"""
    referencers: list[str] = []
    if state.config.agents.default_model_ref == ref:
        referencers.append("agents.default_model_ref")
    for agent_id, entry in state.config.agents.builtin.items():
        if entry.model_ref == ref:
            referencers.append(f"agents.builtin.{agent_id}")
    for info in state.plugins.list():
        if info.model_ref == ref:
            referencers.append(f"plugin {info.id}")
    return referencers


@router.get("/models")
async def list_models(
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> dict:
    """渠道池全量（密钥脱敏；含基底与本地覆盖的合并视图）。"""
    models = [
        _channel_view(state, ref, entry).model_dump()
        for ref, entry in state.config.models.items()
    ]
    return {"models": models}


@router.put("/models/{ref}")
async def put_model(
    ref: str,
    payload: ModelChannelInput,
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> dict:
    """更新或创建渠道：校验（非法 provider/thinking → 422）→ 写
    config.local.toml → 运行时即时生效（providers 表原地替换）。"""
    try:
        entry = ModelConfig.model_validate(payload.model_dump())
        # 与启动加载一致的引用完整性：非 mock 渠道需 base_url + 密钥来源
        if entry.provider != "mock":
            missing = [
                name
                for name, value in (
                    ("base_url", entry.base_url),
                    ("api_key_env or api_key_inline",
                     entry.api_key_env or entry.api_key_inline),
                )
                if not value
            ]
            if missing:
                raise ValueError(f"provider {entry.provider!r} requires {', '.join(missing)}")
    except Exception as exc:
        from qap.core.errors import ValidationFailed

        raise ValidationFailed(f"invalid model channel {ref!r}: {exc}") from exc
    if state.local_store is None:  # 组装缺位防御（无文件落点即无法持久化）
        raise ConflictError("no config.local.toml backing store configured")
    # 内联密钥只落本地文件（绝不回传、绝不出现在基底配置）
    state.local_store.upsert_model(ref, entry.model_dump())
    state.config.models[ref] = entry
    state.providers[ref] = _build_provider(entry)
    return _channel_view(state, ref, entry).model_dump()


@router.delete("/models/{ref}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(
    ref: str,
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> Response:
    """删除本地覆盖渠道；基底渠道或被引用渠道 → 409。"""
    if ref in state.base_model_refs:
        raise ConflictError(
            f"model channel {ref!r} is defined in the base config.toml and "
            "cannot be deleted (override or disable it instead)"
        )
    if ref not in state.config.models:
        raise NotFoundError("model channel", ref)
    referencers = _referencing_agents(state, ref)
    if referencers:
        raise ConflictError(
            f"model channel {ref!r} is still referenced by: "
            + ", ".join(referencers)
        )
    if state.local_store is not None:
        state.local_store.delete_model(ref)
    state.config.models.pop(ref, None)
    state.providers.pop(ref, None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _build_provider(entry: ModelConfig):
    """为渠道构造 provider（工厂；本地导入避免循环依赖风险）。"""
    from qap.agents.providers.factory import create_provider

    return create_provider(entry)


# ---------- 插件 ----------

@router.post("/plugins/install", status_code=status.HTTP_201_CREATED)
async def install_plugin(
    payload: InstallPluginRequest,
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> dict:
    """安装插件（来源目录校验 → 复制 → 注册并刷新 orchestrator 专家清单）。"""
    return state.plugin_manager.install(payload.source_path)


@router.get("/plugins")
async def list_plugins(
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> dict:
    """全部插件的管理视图（含 broken 原因；密钥无关，无脱敏需求）。"""
    return {"plugins": state.plugin_manager.list_plugins()}


@router.put("/plugins/{plugin_id}")
async def set_plugin_enabled(
    plugin_id: str,
    payload: PluginEnableRequest,
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> dict:
    """启停插件；状态持久化到 config.local.toml（builtin 亦可启停）。"""
    return state.plugin_manager.set_enabled(plugin_id, payload.enabled)


@router.delete("/plugins/{plugin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_plugin(
    plugin_id: str,
    tenant: TenantContext = Depends(require_admin),
    state: AppState = Depends(get_state),
) -> Response:
    """卸载已安装插件（删目录 + 清持久化状态）；builtin → 409。"""
    state.plugin_manager.uninstall(plugin_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
