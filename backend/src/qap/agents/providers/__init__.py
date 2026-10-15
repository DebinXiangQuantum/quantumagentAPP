"""providers —— 统一 LLM Provider 抽象（契约 §9）。

两种真实 wire format 实现：openai（Chat Completions 流式）、anthropic
（Messages 流式）。v1.6 去 mock 化：产品**不存在任何 mock/假模型渠道**。
测试策略：openai/anthropic 的解析逻辑用 httpx MockTransport 回放规范与
畸形样例；端到端链路由 tests/scripted_provider.py 的测试替身驱动——
两者都绝不发真实网络请求、绝不调用真实 LLM。
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
