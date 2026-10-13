"""Anthropic Messages 流式 Provider（契约 §9 表第 2 行）。

wire format 要点（事实来源：docs.anthropic.com messages-streaming）：
- ``POST {base_url}/v1/messages``，JSON 体 ``stream: true``（``max_tokens``
  为该 API 必填字段——工程取 4096，原型无截断需求）；
- 鉴权头 ``x-api-key`` 与 ``anthropic-version: 2023-06-01``；
- SSE 事件流带 ``event:`` 行；关键事件：
  * ``content_block_start``（content_block.type == "tool_use"）→ 打开一个
    工具入参累积器（id/name）；
  * ``content_block_delta``：``delta.type == "text_delta"`` → 文本增量；
    ``delta.type == "input_json_delta"`` → ``partial_json`` 分片，逐片拼接
    成完整工具入参 JSON；
  * ``content_block_stop`` → 若有打开的工具累积器，产出完整 ToolCall；
  * ``message_stop`` → 本轮结束（stop_reason 取自 message_delta 事件）。
- 消息翻译：中间表示的 tool 结果 → user 消息里的 ``tool_result`` 块，
  assistant 工具调用 → ``tool_use`` 块（id 贯穿两侧，原型保真度足够）。

故障语义与 openai provider 对称：非 200 / 非法 JSON / 流中断 →
ProviderErrorEvent，绝不外抛。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx

from qap.agents.providers.base import (
    CompletionRequest,
    ProviderErrorEvent,
    ProviderEvent,
    TextDelta,
    ToolCall,
    TurnCompleted,
)
from qap.agents.providers.sse import iter_sse_events
from qap.core.config import ModelConfig

#: anthropic-version 头的固定值（契约 §9）
ANTHROPIC_VERSION = "2023-06-01"
#: max_tokens 工程取值（API 必填；原型不追求精确预算控制）
DEFAULT_MAX_TOKENS = 4096
#: 流式读超时下限（秒），与 openai provider 同理
_STREAM_READ_TIMEOUT_FLOOR = 5.0


class _ToolAccumulator:
    """一个 tool_use content block 的入参累积器。"""

    def __init__(self, block_id: str, name: str) -> None:
        self.block_id = block_id
        self.name = name
        self.partial_json = ""


class AnthropicProvider:
    """Anthropic Messages wire format 的流式实现（可注入 transport 测试回放）。"""

    def __init__(
        self,
        config: ModelConfig,
        api_key_lookup: Callable[[], str | None],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
        self._api_key_lookup = api_key_lookup
        self._transport = transport

    # ---------- 请求构造 ----------

    def _build_payload(self, request: CompletionRequest) -> dict[str, Any]:
        """中间表示 → anthropic 请求体（system 独立字段；工具结果转块）。"""
        messages: list[dict[str, Any]] = []
        for message in request.messages:
            role = message["role"]
            if role == "tool":
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": message.get("tool_call_id", ""),
                                "content": message.get("content", ""),
                            }
                        ],
                    }
                )
            elif role == "assistant" and message.get("tool_calls"):
                content: list[dict[str, Any]] = []
                if message.get("content"):
                    content.append({"type": "text", "text": message["content"]})
                for record in message["tool_calls"]:
                    content.append(
                        {
                            "type": "tool_use",
                            "id": record.id,
                            "name": record.name,
                            "input": json.loads(record.arguments or "{}"),
                        }
                    )
                messages.append({"role": "assistant", "content": content})
            else:
                messages.append(
                    {"role": role, "content": [{"type": "text", "text": message.get("content", "")}]}
                )
        payload: dict[str, Any] = {
            "model": self._config.model,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "stream": True,
            "messages": messages,
        }
        if request.system:
            payload["system"] = request.system
        if request.tools:
            payload["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.parameters,
                }
                for tool in request.tools
            ]
        return payload

    # ---------- 流式主流程 ----------

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        api_key = self._api_key_lookup()
        if not api_key:
            yield ProviderErrorEvent(
                f"api key env {self._config.api_key_env!r} is not set "
                f"(model {self._config.model!r})"
            )
            return
        url = f"{(self._config.base_url or '').rstrip('/')}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        timeout = httpx.Timeout(max(_STREAM_READ_TIMEOUT_FLOOR, self._config.timeout_seconds))
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
                async with client.stream(
                    "POST", url, headers=headers, json=self._build_payload(request)
                ) as response:
                    if response.status_code != 200:
                        body = (await response.aread()).decode("utf-8", "replace")[:300]
                        yield ProviderErrorEvent(
                            f"anthropic: HTTP {response.status_code}: {body}"
                        )
                        return
                    async for event in self._stream_response(response):
                        yield event
        except httpx.HTTPError as exc:
            yield ProviderErrorEvent(f"anthropic: stream interrupted: {exc}")

    async def _stream_response(
        self, response: httpx.Response
    ) -> AsyncIterator[ProviderEvent]:
        """解析 200 响应的 SSE 体（事件名 + data 双行协议）。"""
        current_tool: _ToolAccumulator | None = None
        stop_reason: str | None = None
        saw_tool_use = False
        async for event_name, data in iter_sse_events(response.aiter_lines()):
            try:
                payload = json.loads(data) if data else {}
            except json.JSONDecodeError as exc:
                yield ProviderErrorEvent(
                    f"anthropic: malformed JSON line: {exc}; line={data[:120]}"
                )
                return
            kind = event_name or payload.get("type", "")
            if kind == "content_block_start":
                block = payload.get("content_block") or {}
                if block.get("type") == "tool_use":
                    current_tool = _ToolAccumulator(
                        block_id=block.get("id", "toolu_0"), name=block.get("name", "")
                    )
                    saw_tool_use = True
            elif kind == "content_block_delta":
                delta = payload.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield TextDelta(delta["text"])
                elif delta.get("type") == "input_json_delta" and current_tool is not None:
                    current_tool.partial_json += delta.get("partial_json", "")
            elif kind == "content_block_stop":
                if current_tool is not None:
                    yield ToolCall(current_tool.name, current_tool.partial_json or "{}")
                    current_tool = None
            elif kind == "message_delta":
                stop_reason = (payload.get("delta") or {}).get("stop_reason") or stop_reason
            elif kind == "message_stop":
                break
        yield TurnCompleted("tool_use" if saw_tool_use else (stop_reason or "stop"))
