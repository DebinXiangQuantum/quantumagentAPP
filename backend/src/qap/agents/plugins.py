"""Agent 插件：接口协议 + 三个内置演示插件 + 注册表（契约 §8）。

接口即接入范式：后续 pulseagent 等外部插件以同构方式接入——
清单对齐 agent-plugins.org schema 1.0.0（plugin.json + Python 入口），
原型阶段外部目录加载抛"未实现"（契约 §8 明示允许）。

插件只声明**领域工具**；平台级工具（emit_artifact / submit_task /
query_hardware）由 Runtime 注入，对所有 Agent 可用（见 tools.py）。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Protocol, Sequence, runtime_checkable

from qap.core.config import AgentsConfig
from qap.core.errors import NotFoundError, QapError
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


# ---------- 内置演示插件 ----------

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


#: 三个内置演示插件（契约 §8）；model_ref 为缺省，注册表按配置覆盖
BUILTIN_PLUGINS: tuple[_BuiltinPlugin, ...] = (
    _BuiltinPlugin(
        id="algorithm-designer",
        name="量子算法设计",
        description="把化学/优化问题建模为变分量子线路，产出线路与测量计数并提交全流程任务",
        capabilities=("problem-modeling", "circuit-synthesis", "vqe-pipelines"),
        model_ref="default",
        system_prompt=(
            "你是量子算法设计专家。收到问题后：先简述方案，"
            "用 emit_artifact 附上线路与模拟计数，再用 submit_task 提交"
            "分子积分→VQE 执行→结果后处理的三步任务，最后收束总结。"
        ),
    ),
    _BuiltinPlugin(
        id="calibration",
        name="量子校准 / 波形校准",
        description="读取校准数据，生成 DRAG 修正波形并可视化",
        capabilities=("calibration", "waveform-synthesis"),
        model_ref="default",
        system_prompt=(
            "你是量子校准专家。根据用户的校准需求，用 emit_artifact 附上"
            "生成的波形（waveform 类型），并给出调参建议。"
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
)


class PluginRegistry:
    """插件注册表：内置插件按配置启停/绑定模型；外部插件目录预留。"""

    def __init__(
        self,
        config: AgentsConfig,
        *,
        plugins: Sequence[AgentPlugin] | None = None,
    ) -> None:
        # 候选：默认内置三件套；测试/扩展可注入自定义插件序列
        candidates: list[AgentPlugin] = (
            list(plugins) if plugins is not None else list(BUILTIN_PLUGINS)
        )
        final: list[AgentPlugin] = []
        for plugin in candidates:
            entry = config.builtin.get(plugin.id)
            if entry is not None and not entry.enabled:
                continue  # 配置显式禁用：不注册
            if entry is not None and isinstance(plugin, _BuiltinPlugin):
                if entry.model_ref != plugin.model_ref:
                    plugin = replace(plugin, model_ref=entry.model_ref)  # 配置覆盖绑定
            final.append(plugin)
        self._plugins: dict[str, AgentPlugin] = {}
        for plugin in final:
            self.register(plugin)
        # 外部插件目录：目录缺失/为空 = 正常（无外部插件可装）；
        # 含插件目录时的发现与加载在 v1.1 §8（B3 切片）实现，此前显式报错。
        if config.plugins_dir.strip():
            from pathlib import Path

            external = Path(config.plugins_dir)
            if external.is_dir() and any(external.iterdir()):
                raise QapError(
                    "external_plugins_unimplemented",
                    f"loading external plugins from {config.plugins_dir!r} is not "
                    "implemented yet (see ARCHITECTURE §8)",
                )

    def register(self, plugin: AgentPlugin) -> None:
        """注册插件；重复 id 立即拒绝（清单一致性）。"""
        if plugin.id in self._plugins:
            raise ValueError(f"duplicate plugin id {plugin.id!r}")
        self._plugins[plugin.id] = plugin

    def get(self, agent_id: str) -> AgentPlugin:
        plugin = self._plugins.get(agent_id)
        if plugin is None:
            raise NotFoundError("agent", agent_id)
        return plugin

    def list(self) -> list[AgentInfo]:
        """全部已注册插件的 AgentInfo 视图（GET /api/v1/agents 响应体）。"""
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
