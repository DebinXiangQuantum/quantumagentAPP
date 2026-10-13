"""OpenAI Chat Completions 流式 Provider（契约 §9 表第 1 行）。

wire format 要点（事实来源：platform.openai.com streaming 文档）：
- ``POST {base_url}/chat/completions``，JSON 体 ``stream: true``；
- 鉴权头 ``Authorization: Bearer $KEY``（密钥从 ``api_key_env`` 环境变量
  **在实际调用时**读取，缺失仅让本次调用失败）；
- SSE ``data:`` 行 → JSON；``data: [DONE]`` 结束；
- ``choices[0].delta.content`` 是文本增量；
- ``choices[0].delta.tool_calls[]`` 按 ``index`` 分片到达：name 只在首片
  出现，``function.arguments`` 是**分片字符串**，须逐片拼接，流结束后
  才产出完整 ToolCall；
- ``choices[0].finish_reason`` ∈ stop|tool_calls|length。

故障语义（负样本测试覆盖）：非 200 → ProviderErrorEvent（附状态码与体摘
要）；非法 JSON 行 → ProviderErrorEvent 并终止；网络层异常（流中断）→
ProviderErrorEvent。绝不抛出到调用方。
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
    ThoughtDelta,
    ToolCall,
    TurnCompleted,
    tool_fields,
)
from qap.agents.providers.sse import iter_sse_events
from qap.core.config import ModelConfig, ThinkingLevel

#: 流式读超时下限（秒）：外层总超时由 ModelConfig.timeout_seconds 控制，
#: 但读间隙不应小于该值，避免长思考模型被误判断流。
_STREAM_READ_TIMEOUT_FLOOR = 5.0

#: §9 v1.1 映射（2026-10-13 冒烟实测修正）：openai 兼容（GLM）渠道
#: ``thinking.type`` 只接受 enabled/disabled——思考强度走**独立顶层参数**
#: ``reasoning_effort``（官方文档 docs.bigmodel.cn …/capabilities/thinking；
#: 实测 low/high/max 直接作 type 值会被 1210 拒绝）。
#: off → disabled；low/high/max → enabled + reasoning_effort 同名。
_OFF_THINKING_TYPE = "disabled"
_ON_THINKING_TYPE = "enabled"


def thinking_params_for(level: ThinkingLevel) -> dict[str, object]:
    """思考程度 → openai 请求体的思考参数（thinking + reasoning_effort）。

    注意：glm-5.3 系列不接受 ``disabled``（服务端错误码 1210 会作为
    error 事件透传）——这是渠道侧行为，由调用方选择 off 时自担。
    """
    if level == "off":
        return {"thinking": {"type": _OFF_THINKING_TYPE}}
    if level in ("low", "high", "max"):
        return {"thinking": {"type": _ON_THINKING_TYPE}, "reasoning_effort": level}
    raise ValueError(f"unknown thinking level {level!r}")


class _AccumulatingToolCall:
    """按 index 累积一个 tool_call 的 name 与分片 arguments。"""

    def __init__(self, call_id: str) -> None:
        self.call_id = call_id
        self.name = ""
        self.arguments = ""


class OpenAIProvider:
    """OpenAI 兼容 wire format 的流式实现（可注入 transport 供测试回放）。"""

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
        """中间表示 → openai 请求体（system 消息前置，tools 转 function 声明）。"""
        messages: list[dict[str, Any]] = []
        if request.system:
            messages.append({"role": "system", "content": request.system})
        for message in request.messages:
            role = message["role"]
            if role == "tool":
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": message.get("tool_call_id", ""),
                        "content": message.get("content", ""),
                    }
                )
            elif role == "assistant" and message.get("tool_calls"):
                messages.append(
                    {
                        "role": "assistant",
                        "content": message.get("content") or None,
                        "tool_calls": [
                            {
                                "id": record.id,
                                "type": "function",
                                "function": {
                                    "name": record.name,
                                    "arguments": record.arguments,
                                },
                            }
                            for record in message["tool_calls"]
                        ],
                    }
                )
            else:
                messages.append({"role": role, "content": message.get("content", "")})
        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": messages,
            "stream": True,
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": parameters,
                    },
                }
                for name, description, parameters in (
                    tool_fields(tool) for tool in request.tools
                )
            ]
        # v1.1 §9（实测修正）：off → thinking.disabled；low/high/max →
        # thinking.enabled + 顶层 reasoning_effort；未指定则完全省略。
        if request.thinking_level is not None:
            payload.update(thinking_params_for(request.thinking_level))
        return payload

    # ---------- 流式主流程 ----------

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        """执行一次流式补全；所有故障折叠为 ProviderErrorEvent。"""
        api_key = self._api_key_lookup()
        if not api_key:
            yield ProviderErrorEvent(
                f"api key env {self._config.api_key_env!r} is not set "
                f"(model {self._config.model!r})"
            )
            return
        url = f"{(self._config.base_url or '').rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
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
                            f"openai: HTTP {response.status_code}: {body}"
                        )
                        return
                    async for event in self._stream_response(response):
                        yield event
        except httpx.HTTPError as exc:
            yield ProviderErrorEvent(f"openai: stream interrupted: {exc}")
        except Exception as exc:  # provider 契约：任何故障事件化，绝不外抛
            yield ProviderErrorEvent(f"openai: unexpected failure: {exc}")

    async def _stream_response(
        self, response: httpx.Response
    ) -> AsyncIterator[ProviderEvent]:
        """解析 200 响应的 SSE 体：增量文本 + tool_calls 拼接 + 终止语义。"""
        pending_tools: dict[int, _AccumulatingToolCall] = {}
        finish_reason: str | None = None
        async for event_name, data in iter_sse_events(response.aiter_lines()):
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError as exc:
                yield ProviderErrorEvent(f"openai: malformed JSON line: {exc}; line={data[:120]}")
                return
            choices = chunk.get("choices") or []
            if not choices:
                continue  # 心跳/usage 帧
            choice = choices[0]
            delta = choice.get("delta") or {}
            # v1.1：GLM/DeepSeek 式思考增量（先于正文到达）→ ThoughtDelta
            reasoning = delta.get("reasoning_content")
            if reasoning:
                yield ThoughtDelta(reasoning)
            content = delta.get("content")
            if content:
                yield TextDelta(content)
            for fragment in delta.get("tool_calls") or []:
                index = int(fragment.get("index", 0))
                accumulator = pending_tools.setdefault(
                    index, _AccumulatingToolCall(fragment.get("id", f"call-{index}"))
                )
                function = fragment.get("function") or {}
                if function.get("name"):
                    accumulator.name = function["name"]
                if function.get("arguments"):
                    accumulator.arguments += function["arguments"]
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
        # 流结束：先吐完整工具调用，再宣告本轮完成
        for index in sorted(pending_tools):
            accumulator = pending_tools[index]
            yield ToolCall(accumulator.name, accumulator.arguments or "{}")
        yield TurnCompleted("tool_use" if pending_tools else (finish_reason or "stop"))
