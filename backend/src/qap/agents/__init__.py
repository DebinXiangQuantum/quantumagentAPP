"""agents —— 插件注册表、平台工具与 Agent 运行时（契约 §8）。"""

from qap.agents.plugins import (
    AgentPlugin,
    BUILTIN_PLUGINS,
    PluginRegistry,
    ToolSpec,
)
from qap.agents.runtime import AgentRuntime
from qap.agents.tools import PlatformTools, ToolContext

__all__ = [
    "AgentPlugin",
    "AgentRuntime",
    "BUILTIN_PLUGINS",
    "PlatformTools",
    "PluginRegistry",
    "ToolContext",
    "ToolSpec",
]
