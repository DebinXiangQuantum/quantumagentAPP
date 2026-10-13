"""Provider 抽象基座：请求/事件类型与 LLMProvider 协议（契约 §9）。

消息格式（provider 无关的内部中间表示，由 Runtime 构造）：
- ``{"role": "system"|"user"|"assistant", "content": str}``
- ``{"role": "assistant", "content": str, "tool_calls": [ToolCallRecord]}``
- ``{"role": "tool", "tool_call_id": str, "name": str, "content": str}``
各 Provider 负责把该中间表示翻译成自家 wire format（openai 原生接近；
anthropic 需转 tool_use/tool_result 块）。

事件流约定（契约 §9：text_delta | tool_call | error）：
- ``TextDelta``：一段增量文本（Runtime 直接进 SSE message.delta）；
- ``ToolCall``：一次完整的工具调用（name + arguments **JSON 字符串**，
  增量拼接由 Provider 内部完成后才发出）；
- ``ProviderErrorEvent``：Provider 侧故障（非 200、流中断、密钥缺失……），
  之后流终止、**不再**发 TurnCompleted；
- ``TurnCompleted``：本轮正常结束（内部控制事件，stop_reason 告诉
  Runtime 是否需要回填工具结果并继续循环）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class CompletionRequest:
    """一次补全请求（provider 无关）。

    ``metadata`` 携带运行上下文（run_key / agent_id / conversation_id）：
    mock provider 用 run_key 推进脚本游标，openai/anthropic 忽略之。
    """

    model: str
    messages: list[dict[str, Any]]
    system: str | None = None
    tools: Sequence[Any] | None = None  # ToolSpec 序列（agents.plugins）
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TextDelta:
    """文本增量事件（契约 §9 text_delta）。"""

    text: str


@dataclass(frozen=True)
class ToolCall:
    """完整工具调用事件（契约 §9 tool_call）；arguments 为 JSON 字符串。"""

    name: str
    arguments: str


@dataclass(frozen=True)
class ProviderErrorEvent:
    """Provider 故障事件（契约 §9 error）；发出后流终止。"""

    message: str


@dataclass(frozen=True)
class TurnCompleted:
    """本轮正常结束（内部控制事件）。

    stop_reason：``"stop"`` 纯文本结束；``"tool_use"`` 本轮发生了工具调用，
    Runtime 应回填结果并再次 stream。
    """

    stop_reason: str


#: Provider 事件联合类型（供类型注解使用）
ProviderEvent = TextDelta | ToolCall | ProviderErrorEvent | TurnCompleted


@dataclass(frozen=True)
class ToolCallRecord:
    """历史消息中的工具调用记录（中间表示，provider 翻译时使用）。"""

    id: str
    name: str
    arguments: str


class LLMProvider(Protocol):
    """统一 LLM Provider 协议（契约 §9）。"""

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        """流式补全：按到达顺序产出 ProviderEvent，永不抛网络异常
        （一律转 ProviderErrorEvent 事件，便于 Runtime 统一处理）。"""
        ...
