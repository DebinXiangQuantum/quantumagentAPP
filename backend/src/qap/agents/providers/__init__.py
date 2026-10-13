"""providers —— 统一 LLM Provider 抽象（契约 §9）。

三种 wire format 实现：openai（Chat Completions 流式）、anthropic
（Messages 流式）、mock（脚本化，驱动 §10 端到端演示）。
测试策略：openai/anthropic 的解析逻辑用 httpx MockTransport 回放规范与
畸形样例，绝不发真实网络请求、绝不调用真实 LLM。
"""

from qap.agents.providers.base import (
    CompletionRequest,
    LLMProvider,
    ProviderErrorEvent,
    TextDelta,
    ToolCall,
    ToolCallRecord,
    TurnCompleted,
)
from qap.agents.providers.factory import create_provider

__all__ = [
    "CompletionRequest",
    "LLMProvider",
    "ProviderErrorEvent",
    "TextDelta",
    "ToolCall",
    "ToolCallRecord",
    "TurnCompleted",
    "create_provider",
]
