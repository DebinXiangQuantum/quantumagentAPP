"""S6 OpenAI Provider 测试：httpx MockTransport 回放（零真实网络）。

- 规范样例：增量文本 + tool_calls 分片拼接 + [DONE] 终止 + finish_reason。
- 畸形样例：非法 JSON 行、非 200、流中断、密钥缺失。
- 请求构造：system 前置、tool 结果回填、tools 声明形状。
"""

from __future__ import annotations

import json

import httpx
import pytest

from qap.agents.providers.base import (
    CompletionRequest,
    ProviderErrorEvent,
    TextDelta,
    ToolCall,
    TurnCompleted,
)
from qap.agents.providers.factory import create_provider
from qap.core.config import ModelConfig


def sse(*chunks: str) -> bytes:
    """把若干 SSE 帧文本拼成一个响应体（每帧以空行收尾）。"""
    return "".join(chunk + "\n\n" for chunk in chunks).encode("utf-8")


def make_provider(body: bytes | None = None, status: int = 200, api_key_env: str = "OPENAI_API_KEY"):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        if status != 200:
            return httpx.Response(status, json={"error": "boom"})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    config = ModelConfig(
        provider="openai", model="gpt-4o-mini",
        base_url="https://api.test/v1", api_key_env=api_key_env, timeout_seconds=10,
    )
    provider = create_provider(config, transport=httpx.MockTransport(handler))
    return provider, captured


def make_request(**metadata) -> CompletionRequest:
    return CompletionRequest(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "设计一个 VQE"}],
        system="你是量子算法专家",
        metadata=metadata,
    )


async def collect(provider, request):
    return [event async for event in provider.stream(request)]


class TestHappyPath:
    async def test_text_deltas_in_order(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        body = sse(
            'data: {"choices":[{"delta":{"content":"你好"}}]}',
            'data: {"choices":[{"delta":{"content":"，世界"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        texts = [e.text for e in events if isinstance(e, TextDelta)]
        assert texts == ["你好", "，世界"]
        assert events[-1] == TurnCompleted("stop")

    async def test_tool_call_arguments_assembled_from_fragments(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """契约要点：delta.tool_calls 的 arguments 分片逐片拼接后才产出。"""
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        body = sse(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"emit_artifact","arguments":"{\\"type\\":\\"cou"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nt\\",\\"title\\":\\"X\\"}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            "data: [DONE]",
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        calls = [e for e in events if isinstance(e, ToolCall)]
        assert len(calls) == 1
        assert calls[0].name == "emit_artifact"
        assert json.loads(calls[0].arguments) == {"type": "count", "title": "X"}
        assert events[-1] == TurnCompleted("tool_use")

    async def test_request_shape(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """system 前置、tools 声明、流式标记都进入请求体。"""
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        provider, captured = make_provider(sse("data: [DONE]"))

        class Tool:
            name, description, parameters = "query_hardware", "查询硬件", {"type": "object"}

        request = CompletionRequest(
            model="m",
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "", "tool_calls": [
                    type("R", (), {"id": "call_1", "name": "query_hardware", "arguments": "{}"})()
                ]},
                {"role": "tool", "tool_call_id": "call_1", "name": "query_hardware", "content": "[]"},
            ],
            system="SYS",
            tools=[Tool()],
        )
        await collect(provider, request)
        sent = json.loads(captured["request"].read())
        assert sent["messages"][0] == {"role": "system", "content": "SYS"}
        assert sent["messages"][1] == {"role": "user", "content": "q"}
        assert sent["messages"][2]["tool_calls"][0]["function"]["name"] == "query_hardware"
        assert sent["messages"][3]["role"] == "tool"
        assert sent["stream"] is True
        assert sent["tools"][0]["function"]["name"] == "query_hardware"
        assert captured["request"].headers["authorization"] == "Bearer sk-test"


class TestNegativeSamples:
    async def test_missing_api_key_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """契约 §3：环境变量缺失 → 仅该模型调用时报错（事件化，不抛）。"""
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        provider, _ = make_provider(sse("data: [DONE]"))
        events = await collect(provider, make_request())
        assert isinstance(events[0], ProviderErrorEvent)
        assert "OPENAI_API_KEY" in events[0].message
        assert not any(isinstance(e, TurnCompleted) for e in events)

    async def test_non_200(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        provider, _ = make_provider(None, status=429)
        events = await collect(provider, make_request())
        assert isinstance(events[0], ProviderErrorEvent)
        assert "429" in events[0].message

    async def test_malformed_json_line(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        body = sse(
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: {not-json",
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        errors = [e for e in events if isinstance(e, ProviderErrorEvent)]
        assert len(errors) == 1 and "malformed" in errors[0].message
        assert not any(isinstance(e, TurnCompleted) for e in events)

    async def test_stream_interrupted_midway(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """负样本：连接在部分帧后被重置 → ProviderErrorEvent，无 TurnCompleted。"""
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        async def broken_content():
            yield sse('data: {"choices":[{"delta":{"content":"part"}}]}')
            raise httpx.ReadError("connection reset by peer")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=broken_content()
            )

        config = ModelConfig(
            provider="openai", model="m", base_url="https://api.test/v1",
            api_key_env="OPENAI_API_KEY", timeout_seconds=10,
        )
        provider = create_provider(config, transport=httpx.MockTransport(handler))
        events = await collect(provider, make_request())
        assert any(isinstance(e, TextDelta) for e in events)  # 先收到部分文本
        assert events[-1] == ProviderErrorEvent("x") or isinstance(events[-1], ProviderErrorEvent)
        assert not any(isinstance(e, TurnCompleted) for e in events)

    async def test_empty_choices_frames_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """usage/心跳帧（无 choices）应被跳过而不是报错。"""
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        body = sse(
            'data: {"choices":[{"delta":{"content":"hi"}}]}',
            'data: {"usage":{"total_tokens":3}}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        assert events[-1] == TurnCompleted("stop")
