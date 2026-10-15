"""配置加载器：读取仓库根 config.toml 并做 fail-fast 校验（契约 §3）。

加载规则：
1. 路径解析顺序：环境变量 ``QAP_CONFIG`` → ``./config.toml``（CWD 起）→
   自 CWD 逐级向上探测 → 自本包安装位置逐级向上探测（覆盖
   ``cd backend && PYTHONPATH=src uvicorn qap.main:app`` 的常见布局，
   此时 config.toml 位于 backend/../config.toml，恰被向上探测命中）。
   候选均不存在 → :class:`ConfigError`（启动失败）。
2. **配置覆盖层（v1.1 §3）**：若基底文件同目录存在 ``config.local.toml``
   （gitignored），则**深合并**覆盖其上——dict 递归按键合并、标量直接
   覆盖、list 整体替换；本地文件缺失 = 正常（纯基底加载）。
3. 解析用标准库 ``tomllib``；结构/类型/引用完整性用 Pydantic v2 校验，
   **任何缺键/类型不符/未知键（extra=forbid）/未知 provider/未知 kind/
   负容量/悬空 model_ref 引用 → 立即抛 :class:`ConfigError`**。
4. 密钥：仓库 config.toml 只存 ``api_key_env``（环境变量名）；
   ``api_key_inline`` 明文**只允许出现在 config.local.toml**（管理平台
   写入，见 §5 admin API），本模块只负责读入——密钥本体仅在 Provider
   实际调用时读取，缺失时仅该模型报错。
5. 演示密钥 ``demo-key`` 可被环境变量 ``QAP_DEMO_API_KEY`` 覆盖，
   避免示例值被误当作真实密钥（对任何租户的 api_key == "demo-key" 生效）。
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

#: 演示租户的示例密钥（config.toml 中出现时允许被环境变量覆盖）
DEMO_API_KEY_PLACEHOLDER = "demo-key"
#: 覆盖演示密钥的环境变量名（契约 §3）
DEMO_API_KEY_ENV = "QAP_DEMO_API_KEY"
#: 本地覆盖层文件名（与基底配置同目录；gitignored，契约 §3 v1.1）
LOCAL_CONFIG_FILENAME = "config.local.toml"

#: 支持的 provider wire format（未知值 → 启动失败）。v1.6 去 mock 化：
#: 产品**不存在任何 mock/假模型渠道**——测试替身只在 tests/（契约 §3 v1.6）。
KNOWN_PROVIDERS = frozenset({"openai", "anthropic"})
#: 支持的硬件节点类型（未知值 → 启动失败）
KNOWN_NODE_KINDS = frozenset({"qpu", "gpu", "cpu"})

#: 思考程度归一化枚举（契约 §9 v1.1）
ThinkingLevel = Literal["off", "low", "high", "max"]
#: 合法思考程度集合（校验/文档共用）
KNOWN_THINKING_LEVELS = ("off", "low", "high", "max")


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

    v1.6 去 mock 化：provider 仅 ``openai | anthropic``（两种真实 wire
    format）；一切渠道都必须显式给出 ``base_url`` 与 ``api_key_env``
    **或** ``api_key_inline``（在引用校验阶段强制——产品无零配置渠道，
    测试用占位 base_url/密钥环境变量满足形状）。

    ``default_thinking``（v1.1 §9）：该渠道的默认思考程度，缺省 ``"high"``。
    ``api_key_inline``：明文密钥，**只允许出现在 config.local.toml**
    （gitignored）；仓库 config.toml 出现该键即违反提交纪律（密钥绝不入库）。
    """

    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    provider: Literal["openai", "anthropic"]
    model: str = Field(min_length=1)
    base_url: str | None = None
    api_key_env: str | None = None
    #: 明文密钥（仅本地覆盖层；resolve_api_key 优先于环境变量）
    api_key_inline: str | None = None
    timeout_seconds: float = Field(default=120.0, gt=0)
    #: 默认思考程度（v1.1 §9：消息级 > 渠道 default_thinking > "high"）
    default_thinking: ThinkingLevel = "high"

    @field_validator("provider", mode="before")
    @classmethod
    def _reject_removed_mock(cls, value: str) -> str:
        # v1.6：mock 渠道整体移除——报错必须指向契约而非泛泛的枚举拒绝，
        # 让遗留配置（旧 config.local.toml / admin 请求体）一眼可诊断。
        if value == "mock":
            raise ValueError(
                "provider 'mock' 已按 v1.6 契约移除（产品不存在 mock/假模型"
                "渠道，QPU 真机、LLM 真实渠道）；请改用 openai 或 anthropic "
                "真实渠道（契约 §3 v1.6）"
            )
        return value

    @field_validator("base_url", "api_key_env", "api_key_inline")
    @classmethod
    def _reject_blank(cls, v: str | None) -> str | None:
        # 空串是常见手误（键存在但值没填），与缺键同罪：fail-fast。
        if v is not None and not v.strip():
            raise ValueError("must be a non-empty string when present")
        return v


class PluginStateConfig(_StrictModel):
    """``[agents.plugin_state."<id>"]``：插件启停的持久化状态（v1.1 §8）。

    只写 config.local.toml（管理平台"插件管理"入口）；缺省 enabled=true。
    """

    enabled: bool = True


class BuiltinAgentConfig(_StrictModel):
    """``[agents.builtin.<id>]``：内置插件的开关与模型绑定。"""

    enabled: bool
    model_ref: str = Field(min_length=1)


class AgentsConfig(_StrictModel):
    """``[agents]``：默认模型引用、外部插件目录、内置插件清单与插件状态。"""

    default_model_ref: str = Field(min_length=1)
    plugins_dir: str = ""
    builtin: dict[str, BuiltinAgentConfig] = Field(default_factory=dict)
    #: 插件启停状态（来自本地覆盖层；对内置与已安装插件统一生效）
    plugin_state: dict[str, PluginStateConfig] = Field(default_factory=dict)


class TopologyConfig(_StrictModel):
    """QPU 网格拓扑声明（v1.2 ``topology = {rows, cols}``）。

    约束：``rows``/``cols`` ≥ 1 且 ``2 ≤ rows*cols ≤ 1024``（原型网格
    规模界；1 比特无耦合意义，>1024 超出原型保真度演示需求）。
    """

    rows: int = Field(ge=1)
    cols: int = Field(ge=1)

    @model_validator(mode="after")
    def _check_grid_size(self) -> "TopologyConfig":
        qubits = self.rows * self.cols
        if not 2 <= qubits <= 1024:
            raise ValueError(
                f"topology rows*cols must be within [2,1024], got {qubits} "
                f"({self.rows}x{self.cols})"
            )
        return self


class HardwareNodeConfig(_StrictModel):
    """单个模拟硬件节点（v1.2 起 per-node 可选监控规格键）。

    可选键与 kind 严格绑定（错配 → 启动 fail-fast）：
    - ``topology``（仅 qpu）：rows×cols 网格，驱动 QPU metrics 拓扑数据；
    - ``vram_total_gb``（仅 gpu，> 0）：显存总量；
    - ``cpu_cores`` + ``memory_total_gb``（仅 cpu，成对出现，> 0）：
      经典节点规格；
    - ``status``：``online``（缺省）| ``offline``——离线节点不可调度
      （调度器/分配器跳过，前端降饱和标注）。

    规格键缺失时该节点 ``metrics`` 为 None（契约 §4：可缺省，前端降级）。
    """

    id: str = Field(min_length=1)
    kind: Literal["qpu", "gpu", "cpu"]
    name: str = Field(min_length=1)
    model: str = Field(min_length=1)
    capacity: int = Field(ge=1)
    status: Literal["online", "offline"] = "online"
    topology: TopologyConfig | None = None
    vram_total_gb: float | None = Field(default=None, gt=0)
    cpu_cores: int | None = Field(default=None, ge=1)
    memory_total_gb: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _check_kind_key_alignment(self) -> "HardwareNodeConfig":
        kind = self.kind
        mismatches: list[str] = []
        if self.topology is not None and kind != "qpu":
            mismatches.append(f"topology is only allowed on kind='qpu' (got {kind!r})")
        if self.vram_total_gb is not None and kind != "gpu":
            mismatches.append(f"vram_total_gb is only allowed on kind='gpu' (got {kind!r})")
        if kind != "cpu" and (self.cpu_cores is not None or self.memory_total_gb is not None):
            mismatches.append(f"cpu_cores/memory_total_gb are only allowed on kind='cpu' (got {kind!r})")
        if kind == "cpu" and (self.cpu_cores is None) != (self.memory_total_gb is None):
            mismatches.append("cpu metrics require both cpu_cores and memory_total_gb")
        if mismatches:
            raise ValueError("; ".join(mismatches))
        return self


class HardwareConfig(_StrictModel):
    """``[hardware]``：数据源模式与利用率模拟器（契约 §3 v1.4）。

    - ``provider``（v1.4）：``simulated``（缺省——本地模拟机群）|
      ``logicalcloud``（QPU 节点启动时从云端实拉，config 手写 qpu 条目被
      忽略、GPU/CPU 模拟节点保留；拉取失败或密钥缺失 → 启动 fail-fast，
      真实模式禁止静默回退到伪造数据）；
    - ``lqcloud_base_url`` / ``lqcloud_api_key_env``（v1.4）：logicalcloud
      端点与密钥环境变量名（密钥绝不写入本文件；缺省
      https://cloud.logicalqubit.com / LQCLOUD_API_KEY）；
    - ``simulated``/``tick_seconds``：利用率模拟器开关与刷新周期——
      模拟器只作用于 simulated 节点（logicalcloud 的 lq-* 节点利用率
      无云端数据 → 恒 0 不漂移，诚实降级）；
    - ``nodes``：手写节点表。simulated 模式要求非空；logicalcloud 模式
      允许为空（QPU 全部实拉）。
    """

    provider: Literal["simulated", "logicalcloud"] = "simulated"
    lqcloud_base_url: str = Field(
        default="https://cloud.logicalqubit.com", min_length=1
    )
    lqcloud_api_key_env: str = Field(default="LQCLOUD_API_KEY", min_length=1)
    simulated: bool
    tick_seconds: float = Field(gt=0)
    nodes: list[HardwareNodeConfig] = Field(default_factory=list)

    @field_validator("lqcloud_base_url", "lqcloud_api_key_env")
    @classmethod
    def _reject_blank(cls, value: str) -> str:
        # 空白串与缺键同罪：fail-fast（对齐 ModelConfig 的同款规则）。
        if not value.strip():
            raise ValueError("must be a non-empty string when present")
        return value

    @field_validator("nodes")
    @classmethod
    def _reject_duplicate_ids(cls, nodes: list[HardwareNodeConfig]) -> list[HardwareNodeConfig]:
        ids = [n.id for n in nodes]
        if len(ids) != len(set(ids)):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            raise ValueError(f"duplicate hardware node ids: {dupes}")
        return nodes

    @model_validator(mode="after")
    def _check_provider_node_requirements(self) -> "HardwareConfig":
        if self.provider == "simulated" and not self.nodes:
            raise ValueError(
                "hardware.provider='simulated' requires at least one "
                "[[hardware.nodes]] entry (switch provider='logicalcloud' "
                "to fetch QPUs from the cloud)"
            )
        return self


class SchedulerConfig(_StrictModel):
    """``[scheduler]``：全局并行上限、单步超时、失败重试开关。"""

    max_parallel_steps: int = Field(ge=1)
    step_timeout_seconds: float = Field(gt=0)
    retry_failed_steps: bool


class TenantConfig(_StrictModel):
    """``[[tenancy.tenants]]``：租户身份与配额。

    ``enabled`` 默认 true；置 false 后其 API Key 仍可被识别但请求被
    拒绝（403，契约 §5）。计数按自然日重置（内存态原型）。
    ``role``（v1.2 §5）：``user``（缺省）| ``admin``——管理端点守卫的
    判定依据（非法值启动拒绝；语义见 tenancy/api 层）。
    """

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    api_key: str = Field(min_length=1)
    max_concurrent_tasks: int = Field(ge=1)
    max_messages_per_day: int = Field(ge=1)
    enabled: bool = True
    role: Literal["user", "admin"] = "user"


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
        """读取模型密钥（内联优先，其次 ``api_key_env`` 环境变量）。

        :returns: 有可用密钥则返回非空值，否则 None（调用方在被实际使用
            时才报错，契约 §3：不影响其他模型）。
        :raises KeyError: model_ref 未在配置中定义（编程错误）。
        """
        entry = self.models[model_ref]
        if entry.api_key_inline:
            return entry.api_key_inline
        if entry.api_key_env is None:
            return None
        value = os.environ.get(entry.api_key_env)
        return value or None  # 环境变量存在但为空串视为未设置


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
        ref = builtin.model_ref
        # v1.4 保留别名：插件绑定 model_ref == "default" 在运行时解析为
        # agents.default_model_ref（见 api/state.py 的 model_ref_alias）——
        # 别名合法当且仅当 default_model_ref 本身命中渠道（上面已校验）；
        # default_model_ref 悬空时别名同样悬空（别名不是逃逸口）。
        if ref == "default" and config.agents.default_model_ref in model_refs:
            continue
        if ref not in model_refs:
            dangling.append(f"agents.builtin.{agent_id}.model_ref -> {ref!r}")
    if config.tenancy.default_tenant not in {t.id for t in config.tenancy.tenants}:
        dangling.append(f"tenancy.default_tenant -> {config.tenancy.default_tenant!r}")
    if dangling:
        raise ConfigError("dangling references in config.toml: " + "; ".join(dangling))
    # v1.6：一切渠道（openai/anthropic）都必须有 base_url 与密钥来源
    # （env 名或本地内联）——产品无零配置渠道。
    for ref, entry in config.models.items():
        missing = []
        if entry.base_url is None:
            missing.append("base_url")
        if entry.api_key_env is None and entry.api_key_inline is None:
            missing.append("api_key_env/api_key_inline")
        if missing:
            raise ConfigError(
                f"models.{ref}: provider {entry.provider!r} requires "
                f"{', '.join(missing)}"
            )


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """深合并两个已解析的 TOML dict（契约 §3 v1.1 覆盖层语义）。

    - dict 键：递归合并（models 字典因此按键覆盖/新增，条目内字段级覆盖）；
    - list：整体替换（overlay 的 list 完全取代 base 的）；
    - 标量：直接覆盖。
    """
    result: dict[str, Any] = dict(base)
    for key, value in overlay.items():
        existing = result.get(key)
        if isinstance(value, dict) and isinstance(existing, dict):
            result[key] = deep_merge(existing, value)
        else:
            result[key] = value
    return result


@dataclass(frozen=True)
class LoadedConfig:
    """一次加载的完整结果：合并后配置 + 文件溯源（管理 API 需要）。

    ``base_model_refs`` / ``local_model_refs`` 分别是基底与本地文件
    ``[models]`` 表里出现过的 ref 集合——admin DELETE 的"仅可删本地覆盖
    渠道"语义（契约 §5 v1.1）据此判定：可删 = 在本地 ∧ 不在基底。
    """

    config: AppConfig
    base_path: Path
    #: 本地覆盖层路径；文件不存在时为 None（纯基底加载）
    local_path: Path | None
    base_model_refs: frozenset[str]
    local_model_refs: frozenset[str]


def _parse_toml(path: Path) -> dict[str, Any]:
    """解析单个 TOML 文件；语法错误包装为 :class:`ConfigError`。"""
    try:
        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {path}: {exc}") from exc


def _validate(data: dict[str, Any], source: Path) -> AppConfig:
    """结构 + 引用完整性校验；失败统一 :class:`ConfigError`。"""
    _apply_demo_key_override(data)
    try:
        config = AppConfig.model_validate(data)
    except Exception as exc:  # pydantic ValidationError 统一包装为本模块异常
        raise ConfigError(f"invalid config {source}: {exc}") from exc
    _cross_validate(config)
    return config


def _model_refs(data: dict[str, Any]) -> frozenset[str]:
    """从已解析 dict 提取 ``[models]`` 的键集合（不存在则为空）。"""
    models = data.get("models")
    return frozenset(models.keys()) if isinstance(models, dict) else frozenset()


def load_config_with_sources(path: str | Path | None = None) -> LoadedConfig:
    """定位基底配置、叠加本地覆盖层、校验并返回完整溯源信息。

    :param path: 显式基底路径（测试用）；None 时按契约顺序自动探测。
    :raises ConfigError: 文件缺失 / TOML 语法错 / 结构或引用校验失败
        （基底与本地文件任一畸形均 fail-fast）。
    """
    target = Path(path).expanduser().resolve() if path is not None else find_config_path()
    if not target.is_file():
        raise ConfigError(f"config file not found: {target}")
    base_data = _parse_toml(target)
    base_refs = _model_refs(base_data)
    local_candidate = target.parent / LOCAL_CONFIG_FILENAME
    local_path: Path | None = None
    merged = base_data
    local_refs: frozenset[str] = frozenset()
    if local_candidate.is_file():
        local_data = _parse_toml(local_candidate)
        merged = deep_merge(base_data, local_data)
        local_path = local_candidate
        local_refs = _model_refs(local_data)
    return LoadedConfig(
        config=_validate(merged, target),
        base_path=target,
        local_path=local_path,
        base_model_refs=base_refs,
        local_model_refs=local_refs,
    )


def load_config(path: str | Path | None = None) -> AppConfig:
    """定位、解析（含本地覆盖层）、校验配置，返回 :class:`AppConfig`。

    （便捷入口：等价 ``load_config_with_sources(path).config``。）
    """
    return load_config_with_sources(path).config
