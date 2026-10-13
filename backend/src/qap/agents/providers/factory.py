"""Provider 工厂：ModelConfig → 具体 Provider 实例（契约 §9）。

密钥策略：工厂不读密钥本体，只构造"调用时读取环境变量"的闭包——
环境变量缺失不影响其它模型与 Mock（契约 §3）。
测试可通过 ``transport=`` 注入 httpx MockTransport，回放规范/畸形样例。
"""

from __future__ import annotations

import os

import httpx

from qap.agents.providers.anthropic_provider import AnthropicProvider
from qap.agents.providers.base import LLMProvider
from qap.agents.providers.mock_provider import MockProvider
from qap.agents.providers.openai_provider import OpenAIProvider
from qap.core.config import ModelConfig


def create_provider(
    config: ModelConfig, *, transport: httpx.AsyncBaseTransport | None = None
) -> LLMProvider:
    """按 ``config.provider`` 构造 Provider；未知值已在配置校验期拒绝。"""
    api_key_lookup = (
        (lambda: os.environ.get(config.api_key_env)) if config.api_key_env else (lambda: None)
    )
    if config.provider == "openai":
        return OpenAIProvider(config, api_key_lookup, transport=transport)
    if config.provider == "anthropic":
        return AnthropicProvider(config, api_key_lookup, transport=transport)
    if config.provider == "mock":
        return MockProvider()
    raise ValueError(f"unknown provider {config.provider!r}")  # pragma: no cover


__all__: list[str] = ["create_provider"]
