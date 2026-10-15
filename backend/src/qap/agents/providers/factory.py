"""Provider 工厂：ModelConfig → 具体 Provider 实例（契约 §9）。

v1.6 去 mock 化：只构造 **openai / anthropic** 两种真实 wire format——
产品不存在 mock/假模型渠道；零网络的脚本化驱动是测试专属能力
（tests/scripted_provider.py，绝不注册为可选渠道）。

密钥策略：工厂不预读密钥本体，只构造"调用时读取"的闭包——优先级
``api_key_inline``（本地覆盖层内联，v1.1）> ``api_key_env`` 环境变量；
两者皆缺失不影响其它模型（契约 §3，密钥缺失仅在被实际调用时报错）。
测试可通过 ``transport=`` 注入 httpx MockTransport，回放规范/畸形样例。
"""

from __future__ import annotations

import os

import httpx

from qap.agents.providers.anthropic_provider import AnthropicProvider
from qap.agents.providers.base import LLMProvider
from qap.agents.providers.openai_provider import OpenAIProvider
from qap.core.config import ModelConfig


def create_provider(
    config: ModelConfig, *, transport: httpx.AsyncBaseTransport | None = None
) -> LLMProvider:
    """按 ``config.provider`` 构造 Provider；未知/mock 值已在配置校验期
    拒绝（provider 枚举仅 openai|anthropic，契约 §3 v1.6）。"""
    if config.api_key_inline:
        api_key_lookup = lambda: config.api_key_inline  # noqa: E731 - 就地闭包
    elif config.api_key_env:
        api_key_lookup = (lambda env=config.api_key_env: os.environ.get(env))
    else:
        api_key_lookup = (lambda: None)
    if config.provider == "openai":
        return OpenAIProvider(config, api_key_lookup, transport=transport)
    if config.provider == "anthropic":
        return AnthropicProvider(config, api_key_lookup, transport=transport)
    raise ValueError(f"unknown provider {config.provider!r}")  # pragma: no cover


__all__: list[str] = ["create_provider"]
