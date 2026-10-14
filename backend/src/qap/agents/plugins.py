"""Agent 插件：接口协议 + 内置插件（含 v1.1 编排入口）+ 注册表（契约 §8）。

内置四件套（v1.1）：
- ``orchestrator``：平台编排入口。会话 agent_id 缺省即它；系统提示由
  注册表按**当前已注册专家**动态合成（安装/禁用插件后自动刷新），
  独占平台工具 ``dispatch_agent``；
- ``algorithm-designer`` / ``calibration`` / ``echo``：三个领域演示插件。

注册表（v1.1 扩展）：
- 启停优先级：``[agents.plugin_state."<id>"]``（config.local.toml，管理
  平台写）> ``[agents.builtin.<id>]``（config.toml）> 注册缺省 true；
  禁用的插件保留在 ``_disabled``（可再启用），不出现在 /agents 与运行时；
- 外部插件目录（``agents.plugins_dir``，相对路径以基底配置目录解析）：
  启动扫描每个含 plugin.json 的子目录（见 plugin_loader），加载失败
  → 记入 ``broken``（带原因）**不拖垮平台**；
- ``admin_view()``：管理平台列表（builtin/installed/enabled/broken）。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Protocol, Sequence, runtime_checkable

from qap.agents.plugin_loader import load_plugin, read_manifest
from qap.core.config import AgentsConfig, PluginStateConfig
from qap.core.errors import NotFoundError
from qap.domain.models import AgentInfo


@dataclass(frozen=True)
class ToolSpec:
    """工具声明（JSON Schema 参数），provider 翻译时直接使用。"""

    name: str
    description: str
    parameters: dict = field(default_factory=lambda: {"type": "object", "properties": {}})


@runtime_checkable
class AgentPlugin(Protocol):
    """Agent 插件协议（契约 §8）。"""

    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def description(self) -> str: ...
    @property
    def capabilities(self) -> Sequence[str]: ...
    @property
    def model_ref(self) -> str: ...
    @property
    def system_prompt(self) -> str: ...
    @property
    def tools(self) -> Sequence[ToolSpec]: ...


# ---------- 内置插件 ----------

@dataclass(frozen=True)
class _BuiltinPlugin:
    """内置插件的静态描述（无行为差异——行为由 Provider 剧本/模型驱动）。"""

    id: str
    name: str
    description: str
    capabilities: tuple[str, ...]
    model_ref: str
    system_prompt: str
    tools: tuple[ToolSpec, ...] = ()

    def info(self, *, builtin: bool = True) -> AgentInfo:
        return AgentInfo(
            id=self.id,
            name=self.name,
            description=self.description,
            capabilities=list(self.capabilities),
            model_ref=self.model_ref,
            builtin=builtin,
        )


#: 编排 Agent 的固定 id（会话 agent_id 缺省值；dispatch_agent 独占者）
ORCHESTRATOR_ID = "orchestrator"

#: 四个内置插件（契约 §8 v1.1：orchestrator 排末位，专家清单稳定在前）。
#: v1.4 专家真实化：algorithm-designer/calibration 的 system_prompt 为
#: **通用领域提示**（问题分析→适用性→建模→算法选择→线路合成→真实执行
#: 与结果解读），不再绑定 VQE 演示剧本——任何问题由所选真实渠道完成推理。
BUILTIN_PLUGINS: tuple[_BuiltinPlugin, ...] = (
    _BuiltinPlugin(
        id="algorithm-designer",
        name="量子算法设计",
        description=(
            "通用量子算法专家：分析问题、判断量子适用性、建模（含经典-量子"
            "混合），按问题选择算法并合成线路提交真机执行与解读真实结果"
        ),
        capabilities=("problem-modeling", "algorithm-selection",
                      "circuit-synthesis", "hybrid-pipelines"),
        model_ref="default",
        system_prompt=(
            "你是量子算法设计专家，通过所选模型渠道进行**真实推理**。"
            "对任何输入问题，按以下工作流作答：\n"
            "1. 问题分析：明确目标、规模、约束与输入数据；\n"
            "2. 量子适用性判断：哪些部分可能受益于量子加速，哪些应留在经典"
            "计算——不确定时如实说明并给出评估依据；\n"
            "3. 建模：选择合适的数学形式（组合优化 → MIP/QUBO/QUBO 变换；"
            "化学 → 哈密顿量/费米子-比特映射；代数/搜索 → 相应问题形式），"
            "经典-量子混合方案（经典预处理 + 量子内核 + 经典后处理）是常态"
            "而非例外；\n"
            "4. 选择算法：按问题结构、规模与硬件约束在候选算法中权衡"
            "（如 QAOA/VQE/Grover/相位估计/绝热演化/经典求解器兜底），"
            "说明取舍理由；规模小或结构有利时，明确推荐经典解法并解释；\n"
            "5. 合成线路：给出具体量子线路——用 emit_artifact 附上 circuit"
            " 类型产物（门级 {qubits, operations}），再用 submit_task 提交"
            "执行（quantum 步携带 circuit 与 shots，按需指定 node_id；"
            "logicalcloud 硬件模式下将真实提交真机并返回真实测量计数）；\n"
            "6. 解读真实结果：基于任务返回的真实 counts/数据解读，标注数据"
            "来源（cloud-observed 真机观测）；没有真机数据时不要虚构计数，"
            "明确说明缺什么。\n"
            "你提交的任务会由平台真实调度执行——请勿编造执行结果。"
        ),
    ),
    _BuiltinPlugin(
        id="calibration",
        name="量子校准 / 波形校准",
        description="读取校准数据，计算波形修正（如 DRAG）并可视化修正波形",
        capabilities=("calibration", "waveform-synthesis"),
        model_ref="default",
        system_prompt=(
            "你是量子校准专家，通过所选模型渠道进行**真实推理**。工作流：\n"
            "1. 向用户确认/读取校准数据（比特频率、T1/T2、读出保真度、"
            "单/两比特门误差等）与校准目标；\n"
            "2. 分析漂移与误差来源，计算波形修正（如 DRAG 系数、脉冲幅度/"
            "宽度调整、读出脉冲整形）；计算过程给出公式与参数依据，不确定时"
            "如实说明；\n"
            "3. 用 emit_artifact 附上修正前后的 waveform 类型产物"
            "（{sample_rate_ns, unit, channels[{label, samples}]}），并在"
            "文字中给出调参建议与下一步校准实验设计；\n"
            "4. 平台执行的任务与产物均为真实数据（measured/cloud-observed）"
            "——请勿编造校准结果或波形数值。"
        ),
    ),
    _BuiltinPlugin(
        id="echo",
        name="回声演示",
        description="最小演示插件：原样返回用户输入（验证运行时链路）",
        capabilities=("echo",),
        model_ref="default",
        system_prompt="你是回声演示助手：原样重复用户最后一条消息。",
    ),
    _BuiltinPlugin(
        id=ORCHESTRATOR_ID,
        name="编排助手",
        description="平台编排入口：理解任务、选择专家并自主分派子任务（会话缺省 Agent）",
        capabilities=("orchestration", "dispatch"),
        model_ref="default",
        # 占位：真实提示在注册表初始化/专家变化时动态合成（见下）
        system_prompt="",
    ),
)


def compose_orchestrator_prompt(experts: Sequence[AgentPlugin]) -> str:
    """按当前已注册专家合成 orchestrator 系统提示（中文，契约 §8 v1.1）。"""
    lines = [
        "你是 QuantumAgentApp 平台的编排助手（orchestrator）。平台本身不实现"
        "领域算法，而是把任务分派给领域专家并汇总结果。",
        "",
        "平台能力：多专家对话、可视化产物（emit_artifact：circuit/counts/"
        "waveform）、DAG 任务编排（submit_task）、异构硬件查询"
        "（query_hardware：谁在用哪块 GPU/QPU/CPU）。",
        "",
        "当前可用专家：",
    ]
    for expert in experts:
        capabilities = "、".join(expert.capabilities) or "（未声明）"
        lines.append(
            f"- {expert.id}｜{expert.name}：{expert.description}（能力：{capabilities}）"
        )
    lines += [
        "",
        "平台工具（你独占 dispatch_agent）：",
        "- dispatch_agent(agent_id, instruction)：把子任务交给指定专家执行一轮"
        "完整推理（含其领域工具），返回其回复文本；专家附带的产物与提交的"
        "任务会自动归属当前会话与你的当前回复。嵌套深度=1：专家不能再分派。",
        "- emit_artifact / submit_task / query_hardware：需要平台级动作时直接调用。",
        "",
        "工作方式：1) 理解用户任务，必要时先用 query_hardware 了解资源；"
        "2) 选择最合适的专家并 dispatch_agent（instruction 要具体、含上下文）；"
        "3) 阅读专家回复，如信息不足可再次分派或补充说明；4) 用简明中文向用户"
        "汇总结论与产物。任务超出全部专家能力时，如实说明并给出建议。",
        "",
        "诚实性要求（v1.4）：专家会**真实执行**真机任务与产物生成"
        "（submit_task 的 quantum 步在 logicalcloud 硬件模式下提交真机、"
        "返回真实测量计数）——汇报时只引用专家回复与真实任务/产物数据，"
        "勿编造或预演执行结果；没有拿到的数据要明说。",
    ]
    return "\n".join(lines)


# ---------- 注册表 ----------

class PluginRegistry:
    """插件注册表：内置 + 外部（v1.1），启停/坏件/安装目录的运行时账本。"""

    def __init__(
        self,
        config: AgentsConfig,
        *,
        plugins: Sequence[AgentPlugin] | None = None,
        base_dir: Path | None = None,
    ) -> None:
        # 候选：默认内置四件套；测试/扩展可注入自定义插件序列
        candidates: list[AgentPlugin] = (
            list(plugins) if plugins is not None else list(BUILTIN_PLUGINS)
        )
        self._plugins: dict[str, AgentPlugin] = {}
        self._disabled: dict[str, AgentPlugin] = {}  # 已知但被禁用（可再启用）
        self._broken: dict[str, str] = {}  # 目录名（或 id）→ 原因
        self._external_dirs: dict[str, Path] = {}  # 已安装插件 id → 安装目录
        self._builtin_ids: set[str] = set()
        self._plugin_state: dict[str, PluginStateConfig] = dict(config.plugin_state)
        for plugin in candidates:
            entry = config.builtin.get(plugin.id)
            plugin = self._apply_builtin_binding(plugin, entry)
            self._builtin_ids.add(plugin.id)
            if self._effective_enabled(plugin.id, entry):
                self.register(plugin)
            else:
                self._disabled[plugin.id] = plugin
        if config.plugins_dir.strip():
            self._scan_external(self._resolve_plugins_dir(config.plugins_dir, base_dir))
        self._refresh_orchestrator_prompt()

    # ---------- 启停状态 ----------

    def _effective_enabled(self, plugin_id: str, builtin_entry=None) -> bool:
        """启停优先级：plugin_state（本地覆盖层）> builtin 配置 > true。"""
        state = self._plugin_state.get(plugin_id)
        if state is not None:
            return state.enabled
        if builtin_entry is not None:
            return builtin_entry.enabled
        return True

    @staticmethod
    def _apply_builtin_binding(plugin: AgentPlugin, entry) -> AgentPlugin:
        """内置插件按配置覆盖 model_ref 绑定（保持 v1 行为）。"""
        if entry is not None and isinstance(plugin, _BuiltinPlugin):
            if entry.model_ref != plugin.model_ref:
                return replace(plugin, model_ref=entry.model_ref)
        return plugin

    @staticmethod
    def _resolve_plugins_dir(plugins_dir: str, base_dir: Path | None) -> Path:
        """plugins_dir 解析：相对路径以基底配置目录为根（plugins/ 在仓库根）。"""
        path = Path(plugins_dir).expanduser()
        if not path.is_absolute():
            path = (base_dir or Path.cwd()) / path
        return path

    # ---------- 外部插件扫描（§8） ----------

    def _scan_external(self, root: Path) -> None:
        """扫描安装目录：每个含 plugin.json 的子目录尝试加载；失败记 broken。"""
        if not root.is_dir():
            return  # 目录缺失 = 无外部插件（正常）
        for child in sorted(root.iterdir()):
            if not child.is_dir() or not (child / "plugin.json").is_file():
                continue
            try:
                manifest = read_manifest(child)
                plugin = load_plugin(child, manifest)
            except Exception as exc:  # 任何失败都记 broken，不拖垮平台
                self._broken[child.name] = str(exc)
                continue
            if self.knows(plugin.id):
                self._broken[child.name] = f"duplicate plugin id {plugin.id!r}"
                continue
            self._external_dirs[plugin.id] = child
            if self._effective_enabled(plugin.id):
                self._plugins[plugin.id] = plugin
            else:
                self._disabled[plugin.id] = plugin

    # ---------- 注册表操作 ----------

    def register(self, plugin: AgentPlugin) -> None:
        """注册插件；重复 id 立即拒绝（清单一致性）。"""
        if plugin.id in self._plugins:
            raise ValueError(f"duplicate plugin id {plugin.id!r}")
        self._plugins[plugin.id] = plugin
        self._refresh_orchestrator_prompt()

    def unregister(self, plugin_id: str) -> None:
        """移除插件（卸载）；不存在 → NotFoundError。"""
        if plugin_id in self._plugins:
            del self._plugins[plugin_id]
        elif plugin_id in self._disabled:
            del self._disabled[plugin_id]
        else:
            raise NotFoundError("plugin", plugin_id)
        self._broken.pop(plugin_id, None)
        self._external_dirs.pop(plugin_id, None)
        self._plugin_state.pop(plugin_id, None)
        self._refresh_orchestrator_prompt()

    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        """运行时启停（持久化由 PluginManager 负责）；未知 id → NotFoundError。"""
        if plugin_id in self._broken:
            raise NotFoundError("plugin", plugin_id)  # broken 插件不可启停
        if enabled:
            plugin = self._disabled.pop(plugin_id, None)
            if plugin is None:
                if plugin_id not in self._plugins:
                    raise NotFoundError("plugin", plugin_id)
                return  # 已启用：幂等
            self.register(plugin)
        else:
            plugin = self._plugins.pop(plugin_id, None)
            if plugin is None:
                if plugin_id not in self._disabled:
                    raise NotFoundError("plugin", plugin_id)
                return  # 已禁用：幂等
            self._disabled[plugin_id] = plugin
            self._refresh_orchestrator_prompt()

    def attach_external(self, plugin_id: str, install_dir: Path) -> None:
        """登记已安装插件的目录（PluginManager.install 调用）。"""
        self._external_dirs[plugin_id] = install_dir

    def external_dir(self, plugin_id: str) -> Path | None:
        """已安装插件的安装目录（卸载用）；未安装返回 None。"""
        return self._external_dirs.get(plugin_id)

    def knows(self, plugin_id: str) -> bool:
        """id 是否已被占用（启用/禁用/broken 任意状态）。"""
        return (
            plugin_id in self._plugins
            or plugin_id in self._disabled
            or plugin_id in self._broken
        )

    def is_builtin(self, plugin_id: str) -> bool:
        """是否内置插件（内置不可卸载，契约 §8 DELETE → 409）。"""
        return plugin_id in self._builtin_ids

    # ---------- 查询 ----------

    def get(self, agent_id: str) -> AgentPlugin:
        plugin = self._plugins.get(agent_id)
        if plugin is None:
            raise NotFoundError("agent", agent_id)
        return plugin

    def list(self) -> list[AgentInfo]:
        """全部已启用插件的 AgentInfo 视图（GET /api/v1/agents 响应体）。"""
        infos: list[AgentInfo] = []
        for plugin in self._plugins.values():
            if isinstance(plugin, _BuiltinPlugin):
                infos.append(plugin.info(builtin=True))
            else:
                infos.append(
                    AgentInfo(
                        id=plugin.id,
                        name=plugin.name,
                        description=plugin.description,
                        capabilities=list(plugin.capabilities),
                        model_ref=plugin.model_ref,
                        builtin=False,
                    )
                )
        return infos

    def admin_view(self) -> list[dict]:
        """管理平台列表（GET /api/v1/admin/plugins）：全部状态 + broken 原因。"""
        records: list[dict] = []
        seen: set[str] = set()
        for plugin_id, plugin in self._plugins.items():
            records.append(self._record(plugin_id, plugin, enabled=True))
            seen.add(plugin_id)
        for plugin_id, plugin in self._disabled.items():
            records.append(self._record(plugin_id, plugin, enabled=False))
            seen.add(plugin_id)
        for key, reason in self._broken.items():
            if key in seen:  # broken 记录与已注册插件同 id 时以运行态为准
                continue
            records.append(
                {
                    "id": key,
                    "name": key,
                    "description": "",
                    "capabilities": [],
                    "model_ref": "",
                    "builtin": False,
                    "enabled": False,
                    "installed": True,
                    # v1.1 契约对齐：source/version/broken_reason（前端 PluginInfo 期望）
                    "source": "installed",
                    "version": "",
                    "broken": reason,
                    "broken_reason": reason,
                }
            )
        return records

    def _record(self, plugin_id: str, plugin: AgentPlugin, *, enabled: bool) -> dict:
        return {
            "id": plugin_id,
            "name": plugin.name,
            "description": plugin.description,
            "capabilities": list(plugin.capabilities),
            "model_ref": plugin.model_ref,
            "builtin": plugin_id in self._builtin_ids,
            "enabled": enabled,
            "installed": plugin_id in self._external_dirs,
            # source：builtin | installed（前端徽标）；version：内置插件无清单
            # 版本，取插件对象可选属性，缺省空串（前端隐藏空的 v 前缀）
            "source": "builtin" if plugin_id in self._builtin_ids else "installed",
            "version": str(getattr(plugin, "version", "") or ""),
            "broken": None,
            "broken_reason": None,
        }

    # ---------- orchestrator 动态提示 ----------

    def _refresh_orchestrator_prompt(self) -> None:
        """专家集合变化时重合成 orchestrator 系统提示（安装/启停/卸载后）。"""
        plugin = self._plugins.get(ORCHESTRATOR_ID)
        if plugin is None:
            return
        experts = [p for pid, p in self._plugins.items() if pid != ORCHESTRATOR_ID]
        if isinstance(plugin, _BuiltinPlugin):
            self._plugins[ORCHESTRATOR_ID] = replace(
                plugin, system_prompt=compose_orchestrator_prompt(experts)
            )


__all__ = [
    "BUILTIN_PLUGINS",
    "ORCHESTRATOR_ID",
    "AgentPlugin",
    "PluginRegistry",
    "ToolSpec",
    "compose_orchestrator_prompt",
]
