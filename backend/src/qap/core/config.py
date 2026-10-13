"""配置加载器：读取仓库根 config.toml 并做 fail-fast 校验（契约 §3）。

加载规则：
1. 路径解析顺序：环境变量 ``QAP_CONFIG`` → ``./config.toml``（CWD 起）→
   自 CWD 逐级向上探测 → 自本包安装位置逐级向上探测（覆盖
   ``cd backend && PYTHONPATH=src uvicorn qap.main:app`` 的常见布局，
   此时 config.toml 位于 backend/../config.toml，恰被向上探测命中）。
   候选均不存在 → :class:`ConfigError`（启动失败）。
2. 解析用标准库 ``tomllib``；结构/类型/引用完整性用 Pydantic v2 校验，
   **任何缺键/类型不符/未知键（extra=forbid）/未知 provider/未知 kind/
   负容量/悬空 model_ref 引用 → 立即抛 :class:`ConfigError`**。
3. 密钥只从 ``api_key_env`` 指向的环境变量读取（本模块不读密钥本体，
   仅在 Provider 实际发起调用时才读取，缺失时仅该模型报错）。
4. 演示密钥 ``demo-key`` 可被环境变量 ``QAP_DEMO_API_KEY`` 覆盖，
   避免示例值被误当作真实密钥（对任何租户的 api_key == "demo-key" 生效）。
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: 演示租户的示例密钥（config.toml 中出现时允许被环境变量覆盖）
DEMO_API_KEY_PLACEHOLDER = "demo-key"
#: 覆盖演示密钥的环境变量名（契约 §3）
DEMO_API_KEY_ENV = "QAP_DEMO_API_KEY"

#: 支持的 provider wire format（未知值 → 启动失败）
KNOWN_PROVIDERS = frozenset({"openai", "anthropic", "mock"})
#: 支持的硬件节点类型（未知值 → 启动失败）
KNOWN_NODE_KINDS = frozenset({"qpu", "gpu", "cpu"})


class ConfigError(Exception):
    """配置文件缺失/解析失败/校验失败——启动即失败的唯一异常类型。"""


class _StrictModel(BaseModel):
    """所有配置模型的公共基类：禁止未知键，让拼写错误也 fail-fast。"""

    model_config = ConfigDict(extra="forbid")


class ServerConfig(_StrictModel):
    """``[server]``：监听地址与 CORS 白名单。"""

    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    cors_origins: list[str] = Field(default_factory=list)


class ModelConfig(_StrictModel):
    """``[models.<ref>]``：一个模型的 provider 格式与连接参数。

    ``base_url``/``api_key_env``/``timeout_seconds`` 对 mock provider 可缺省
    （进程内、不联网）；对 openai/anthropic 必须显式给出 base_url 与
    api_key_env（在引用校验阶段强制）。
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    provider: Literal["openai", "anthropic", "mock"]
    model: str = Field(min_length=1)
    base_url: str | None = None
    api_key_env: str | None = None
    timeout_seconds: float = Field(default=120.0, gt=0)

    @field_validator("base_url", "api_key_env")
    @classmethod
    def _reject_blank(cls, v: str | None) -> str | None:
        # 空串是常见手误（键存在但值没填），与缺键同罪：fail-fast。
        if v is not None and not v.strip():
            raise ValueError("must be a non-empty string when present")
        return v


class BuiltinAgentConfig(_StrictModel):
    """``[agents.builtin.<id>]``：内置插件的开关与模型绑定。"""

    enabled: bool
    model_ref: str = Field(min_length=1)


class AgentsConfig(_StrictModel):
    """``[agents]``：默认模型引用、外部插件目录、内置插件清单。"""

    default_model_ref: str = Field(min_length=1)
    plugins_dir: str = ""
    builtin: dict[str, BuiltinAgentConfig] = Field(default_factory=dict)


class HardwareNodeConfig(_StrictModel):
    """``[[hardware.nodes]]``：单个模拟硬件节点。

    ``capacity`` = 同时可承载的租约数（步数），必须 ≥ 1；
    负值/零值在解析期即被拒绝（契约 §3 fail-fast）。
    """

    id: str = Field(min_length=1)
    kind: Literal["qpu", "gpu", "cpu"]
    name: str = Field(min_length=1)
    model: str = Field(min_length=1)
    capacity: int = Field(ge=1)


class HardwareConfig(_StrictModel):
    """``[hardware]``：是否启用利用率模拟器与刷新周期。"""

    simulated: bool
    tick_seconds: float = Field(gt=0)
    nodes: list[HardwareNodeConfig] = Field(min_length=1)

    @field_validator("nodes")
    @classmethod
    def _reject_duplicate_ids(cls, nodes: list[HardwareNodeConfig]) -> list[HardwareNodeConfig]:
        ids = [n.id for n in nodes]
        if len(ids) != len(set(ids)):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            raise ValueError(f"duplicate hardware node ids: {dupes}")
        return nodes


class SchedulerConfig(_StrictModel):
    """``[scheduler]``：全局并行上限、单步超时、失败重试开关。"""

    max_parallel_steps: int = Field(ge=1)
    step_timeout_seconds: float = Field(gt=0)
    retry_failed_steps: bool


class TenantConfig(_StrictModel):
    """``[[tenancy.tenants]]``：租户身份与配额。

    ``enabled`` 默认 true；置 false 后其 API Key 仍可被识别但请求被
    拒绝（403，契约 §5）。计数按自然日重置（内存态原型）。
    """

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    api_key: str = Field(min_length=1)
    max_concurrent_tasks: int = Field(ge=1)
    max_messages_per_day: int = Field(ge=1)
    enabled: bool = True


class TenancyConfig(_StrictModel):
    """``[tenancy]``：默认租户与租户清单。"""

    default_tenant: str
    tenants: list[TenantConfig] = Field(min_length=1)

    @field_validator("tenants")
    @classmethod
    def _reject_duplicates(cls, tenants: list[TenantConfig]) -> list[TenantConfig]:
        ids = [t.id for t in tenants]
        if len(ids) != len(set(ids)):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            raise ValueError(f"duplicate tenant ids: {dupes}")
        keys = [t.api_key for t in tenants]
        if len(keys) != len(set(keys)):
            raise ValueError("tenant api_key values must be unique")
        return tenants


class AppConfig(_StrictModel):
    """整份 config.toml 的已校验视图（契约 §3 键名契约的完备实现）。"""

    server: ServerConfig
    models: dict[str, ModelConfig] = Field(min_length=1)
    agents: AgentsConfig
    hardware: HardwareConfig
    scheduler: SchedulerConfig
    tenancy: TenancyConfig

    def resolve_api_key(self, model_ref: str) -> str | None:
        """读取模型密钥（仅从 ``api_key_env`` 指向的环境变量）。

        :returns: 环境变量存在则返回其值，否则 None（调用方在被实际使用
            时才报错，契约 §3：不影响其他模型与 Mock）。
        :raises KeyError: model_ref 未在配置中定义（编程错误）。
        """
        entry = self.models[model_ref]
        if entry.api_key_env is None:
            return None
        return os.environ.get(entry.api_key_env)


def _candidate_paths() -> list[Path]:
    """按契约顺序枚举 config.toml 候选路径（见模块 docstring 第 1 条）。"""
    candidates: list[Path] = []
    env_path = os.environ.get("QAP_CONFIG")
    if env_path:
        candidates.append(Path(env_path).expanduser().resolve())
        return candidates  # 显式指定时不再回退，路径错误应尽早暴露
    # CWD 及其祖先（覆盖 cd backend && uvicorn 的 ../config.toml 布局）
    cwd = Path.cwd().resolve()
    candidates.extend(parent / "config.toml" for parent in [cwd, *cwd.parents])
    # 包安装位置的祖先（覆盖从任意 CWD 以 PYTHONPATH=src 启动的场景）
    pkg_root = Path(__file__).resolve()
    for parent in [pkg_root, *pkg_root.parents]:
        candidate = parent / "config.toml"
        if candidate not in candidates:
            candidates.append(candidate)
    return candidates


def find_config_path() -> Path:
    """返回第一个存在的候选配置路径；不存在则抛 :class:`ConfigError`。"""
    candidates = _candidate_paths()
    for path in candidates:
        if path.is_file():
            return path
    tried = "\n  ".join(str(p) for p in candidates[:8])
    raise ConfigError(
        "config.toml not found; set QAP_CONFIG or run from the repo root."
        f" Tried (first 8):\n  {tried}"
    )


def _apply_demo_key_override(data: dict[str, Any]) -> None:
    """把 ``demo-key`` 替换为 ``QAP_DEMO_API_KEY``（若设置）。

    就地修改已解析的 TOML dict；只影响 api_key 恰为占位值的租户，
    真实密钥不受影响。
    """
    override = os.environ.get(DEMO_API_KEY_ENV)
    if not override:
        return
    for tenant in data.get("tenancy", {}).get("tenants", []):
        if tenant.get("api_key") == DEMO_API_KEY_PLACEHOLDER:
            tenant["api_key"] = override


def _cross_validate(config: AppConfig) -> None:
    """结构校验之后的引用完整性检查（悬空引用 → fail-fast）。"""
    model_refs = set(config.models.keys())
    dangling: list[str] = []
    if config.agents.default_model_ref not in model_refs:
        dangling.append(f"agents.default_model_ref -> {config.agents.default_model_ref!r}")
    for agent_id, builtin in config.agents.builtin.items():
        if builtin.model_ref not in model_refs:
            dangling.append(f"agents.builtin.{agent_id}.model_ref -> {builtin.model_ref!r}")
    if config.tenancy.default_tenant not in {t.id for t in config.tenancy.tenants}:
        dangling.append(f"tenancy.default_tenant -> {config.tenancy.default_tenant!r}")
    if dangling:
        raise ConfigError("dangling references in config.toml: " + "; ".join(dangling))
    # openai/anthropic 必须有 base_url 与 api_key_env（mock 不需要）。
    for ref, entry in config.models.items():
        if entry.provider == "mock":
            continue
        missing = [
            field
            for field in ("base_url", "api_key_env")
            if getattr(entry, field) is None
        ]
        if missing:
            raise ConfigError(
                f"models.{ref}: provider {entry.provider!r} requires "
                f"{', '.join(missing)} (mock provider does not)"
            )


def load_config(path: str | Path | None = None) -> AppConfig:
    """定位、解析并校验配置，返回 :class:`AppConfig`。

    :param path: 显式路径（测试用）；None 时按契约顺序自动探测。
    :raises ConfigError: 文件缺失 / TOML 语法错 / 结构或引用校验失败。
    """
    target = Path(path).expanduser().resolve() if path is not None else find_config_path()
    if not target.is_file():
        raise ConfigError(f"config file not found: {target}")
    try:
        with open(target, "rb") as fh:
            data = tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {target}: {exc}") from exc
    _apply_demo_key_override(data)
    try:
        config = AppConfig.model_validate(data)
    except Exception as exc:  # pydantic ValidationError 统一包装为本模块异常
        raise ConfigError(f"invalid config {target}: {exc}") from exc
    _cross_validate(config)
    return config
