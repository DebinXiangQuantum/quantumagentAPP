"""S6 Anthropic Provider 测试：httpx MockTransport 回放（零真实网络）。

- 规范样例：content_block_delta 的 text_delta / input_json_delta 分片拼接、
  content_block_stop 产出完整 ToolCall、message_stop 终止。
- 畸形样例：非法 JSON、非 200、密钥缺失。
- 请求构造：x-api-key / anthropic-version 头、system 字段、tool_result 块、
  input_schema 声明。
"""

from __future__ import annotations

import json

import httpx
import pytest

from qap.agents.providers.anthropic_provider import ANTHROPIC_VERSION
from qap.agents.providers.base import (
    CompletionRequest,
    ProviderErrorEvent,
    TextDelta,
    ToolCall,
    TurnCompleted,
)
from qap.agents.providers.factory import create_provider
from qap.core.config import ModelConfig


def sse(*frames: tuple[str, str]) -> bytes:
    """(event_name, json) 帧列表 → SSE 体（anthropic 双行协议）。"""
    parts = []
    for name, data in frames:
        parts.append(f"event: {name}\ndata: {data}\n\n")
    return "".join(parts).encode("utf-8")


def make_provider(body: bytes | None = None, status: int = 200):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        if status != 200:
            return httpx.Response(status, json={"error": "overloaded"})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    config = ModelConfig(
        provider="anthropic", model="claude-sonnet-4-5",
        base_url="https://api.test", api_key_env="ANTHROPIC_API_KEY", timeout_seconds=10,
    )
    return create_provider(config, transport=httpx.MockTransport(handler)), captured


def make_request() -> CompletionRequest:
    return CompletionRequest(
        model="claude-sonnet-4-5",
        messages=[{"role": "user", "content": "校准 Q0"}],
        system="你是量子校准专家",
    )


async def collect(provider, request):
    return [event async for event in provider.stream(request)]


class TestHappyPath:
    async def test_text_and_tool_use_flow(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """规范样例：文本增量 + input_json_delta 分片拼接 + 完整 tool_call。"""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        body = sse(
            ("message_start", '{"type":"message_start","message":{}}'),
            ("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"正在"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"生成波形"}}'),
            ("content_block_stop", '{"type":"content_block_stop","index":0}'),
            ("content_block_start", '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"emit_artifact"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"artifact\\":{\\"type\\":"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"waveform\\"}}"}}'),
            ("content_block_stop", '{"type":"content_block_stop","index":1}'),
            ("message_delta", '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}'),
            ("message_stop", '{"type":"message_stop"}'),
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        texts = [e.text for e in events if isinstance(e, TextDelta)]
        assert texts == ["正在", "生成波形"]
        calls = [e for e in events if isinstance(e, ToolCall)]
        assert len(calls) == 1
        assert calls[0].name == "emit_artifact"
        assert json.loads(calls[0].arguments) == {"artifact": {"type": "waveform"}}
        assert events[-1] == TurnCompleted("tool_use")

    async def test_pure_text_completion(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        body = sse(
            ("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}'),
            ("content_block_stop", '{"type":"content_block_stop","index":0}'),
            ("message_delta", '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}'),
            ("message_stop", '{"type":"message_stop"}'),
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        assert events[-1] == TurnCompleted("end_turn")

    async def test_request_shape_and_headers(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        provider, captured = make_provider(sse(("message_stop", '{"type":"message_stop"}')))

        class Tool:
            name, description, parameters = "query_hardware", "查询", {"type": "object"}

        request = CompletionRequest(
            model="m",
            messages=[
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "ok", "tool_calls": [
                    type("R", (), {"id": "toolu_1", "name": "query_hardware", "arguments": "{}"})()
                ]},
                {"role": "tool", "tool_call_id": "toolu_1", "name": "query_hardware", "content": "[]"},
            ],
            system="SYS",
            tools=[Tool()],
        )
        await collect(provider, request)
        sent = json.loads(captured["request"].read())
        assert sent["system"] == "SYS"
        assert sent["stream"] is True
        assert sent["max_tokens"] > 0
        assert sent["tools"][0]["input_schema"] == {"type": "object"}
        # 第二条 assistant 消息带 tool_use 块；第三条转成 user 的 tool_result 块
        assert sent["messages"][1]["content"][1]["type"] == "tool_use"
        assert sent["messages"][2]["role"] == "user"
        assert sent["messages"][2]["content"][0]["type"] == "tool_result"
        assert sent["messages"][2]["content"][0]["tool_use_id"] == "toolu_1"
        headers = captured["request"].headers
        assert headers["x-api-key"] == "ak-test"
        assert headers["anthropic-version"] == ANTHROPIC_VERSION
        assert captured["request"].url.path.endswith("/v1/messages")


class TestNegativeSamples:
    async def test_missing_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        provider, _ = make_provider(b"")
        events = await collect(provider, make_request())
        assert isinstance(events[0], ProviderErrorEvent)
        assert "ANTHROPIC_API_KEY" in events[0].message

    async def test_non_200(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        provider, _ = make_provider(None, status=529)
        events = await collect(provider, make_request())
        assert isinstance(events[0], ProviderErrorEvent)
        assert "529" in events[0].message

    async def test_malformed_json(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        body = b"event: content_block_delta\ndata: {broken\n\n"
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        errors = [e for e in events if isinstance(e, ProviderErrorEvent)]
        assert len(errors) == 1 and "malformed" in errors[0].message
        assert not any(isinstance(e, TurnCompleted) for e in events)

    async def test_error_event_frame_still_parsed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """anthropic error 事件帧（HTTP 200 内）→ 不应崩溃，正常忽略未知事件。"""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        body = sse(
            ("error", '{"type":"error","error":{"type":"overloaded_error"}}'),
            ("message_stop", '{"type":"message_stop"}'),
        )
        provider, _ = make_provider(body)
        events = await collect(provider, make_request())
        assert events[-1] == TurnCompleted("stop")
