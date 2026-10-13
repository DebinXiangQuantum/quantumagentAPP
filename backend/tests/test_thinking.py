"""B2 思考程度与思考流测试（契约 §9 v1.1 映射表 + §7 message.reasoning）。

四类场景映射：
- 不变量：思考增量拼接 == 全文；思考在前正文在后；thinking.type/budget
  映射严格按 §9 表。
- 非法输入拒绝：请求体 thinking_level 非法 → 422；未知 model_ref → 422；
  配置层非法 default_thinking 已在 test_config_overlay 覆盖。
- 负样本：reasoning 与正文交错到达时事件按到达顺序透传（不重排）。
- 可观察行为：请求体 thinking 参数形状（MockTransport 回放，零真实网络）；
  SSE message.reasoning 先于 message.delta；message.completed 带 reasoning
  全文；取值优先级 消息级 > 渠道 default_thinking。
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from qap.agents.providers.anthropic_provider import DEFAULT_MAX_TOKENS
from qap.agents.providers.base import (
    CompletionRequest,
    ThoughtDelta,
    TextDelta,
    TurnCompleted,
)
from qap.agents.providers.factory import create_provider
from qap.core.config import ModelConfig

from tests.test_api_integration import (
    DEMO_HEADERS,
    ClientBundle,
    make_test_config,
    read_sse,
)
from tests.test_provider_anthropic import sse as anthropic_sse
from tests.test_provider_openai import collect, make_request, sse


def make_openai_provider(body: bytes) -> tuple[object, dict]:
    """openai 渠道 + MockTransport 回放体；捕获请求供 thinking 形状断言。"""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )

    config = ModelConfig(
        provider="openai", model="glm-5.3",
        base_url="https://api.test/v1", api_key_env="GLM_API_KEY", timeout_seconds=10,
    )
    provider = create_provider(config, transport=httpx.MockTransport(handler))
    return provider, captured


def make_anthropic_provider(body: bytes) -> tuple[object, dict]:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )

    config = ModelConfig(
        provider="anthropic", model="claude-sonnet-4-5",
        base_url="https://api.test", api_key_env="ANTHROPIC_API_KEY", timeout_seconds=10,
    )
    provider = create_provider(config, transport=httpx.MockTransport(handler))
    return provider, captured


class TestOpenAIThinkingMapping:
    """§9 表第 2 列：openai 兼容（GLM）渠道的 thinking 请求体映射。"""

    @pytest.mark.parametrize(
        ("level", "expected_type"),
        [("off", "disabled"), ("low", "low"), ("high", "high"), ("max", "max")],
    )
    async def test_thinking_type_mapping(
        self, monkeypatch: pytest.MonkeyPatch, level: str, expected_type: str
    ) -> None:
        monkeypatch.setenv("GLM_API_KEY", "sk-test")
        provider, captured = make_openai_provider(sse("data: [DONE]"))
        request = CompletionRequest(
            model="glm-5.3",
            messages=[{"role": "user", "content": "q"}],
            thinking_level=level,  # type: ignore[arg-type]
        )
        await collect(provider, request)
        sent = json.loads(captured["request"].read())
        assert sent["thinking"] == {"type": expected_type}

    async def test_absent_level_omits_thinking_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """未指定 thinking_level → 不发 thinking 键（向后兼容）。"""
        monkeypatch.setenv("GLM_API_KEY", "sk-test")
        provider, captured = make_openai_provider(sse("data: [DONE]"))
        await collect(provider, make_request())
        sent = json.loads(captured["request"].read())
        assert "thinking" not in sent


class TestOpenAIReasoningStream:
    """GLM 形状流：delta.reasoning_content → ThoughtDelta（思考在前正文在后）。"""

    async def test_reasoning_deltas_then_text(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GLM_API_KEY", "sk-test")
        body = sse(
            'data: {"choices":[{"delta":{"reasoning_content":"先分析问题"}}]}',
            'data: {"choices":[{"delta":{"reasoning_content":"，再选算法"}}]}',
            'data: {"choices":[{"delta":{"content":"答案是 VQE"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
        )
        provider, _ = make_openai_provider(body)
        events = await collect(
            provider, CompletionRequest(model="glm-5.3", messages=[{"role": "user", "content": "q"}])
        )
        thoughts = [e.text for e in events if isinstance(e, ThoughtDelta)]
        texts = [e.text for e in events if isinstance(e, TextDelta)]
        # 不变量：思考增量拼接 == 全文
        assert thoughts == ["先分析问题", "，再选算法"]
        assert "".join(thoughts) == "先分析问题，再选算法"
        assert texts == ["答案是 VQE"]
        # 不变量：思考在前，正文在后（首个 TextDelta 晚于最后一个 ThoughtDelta）
        assert events.index(next(e for e in events if isinstance(e, TextDelta))) > events.index(
            next(e for e in reversed(events) if isinstance(e, ThoughtDelta))
        )
        assert events[-1] == TurnCompleted("stop")

    async def test_empty_reasoning_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """reasoning_content 空串/缺失不产生空 ThoughtDelta（负样本噪声）。"""
        monkeypatch.setenv("GLM_API_KEY", "sk-test")
        body = sse(
            'data: {"choices":[{"delta":{"reasoning_content":""}}]}',
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: [DONE]",
        )
        provider, _ = make_openai_provider(body)
        events = await collect(
            provider, CompletionRequest(model="glm-5.3", messages=[{"role": "user", "content": "q"}])
        )
        assert not any(isinstance(e, ThoughtDelta) for e in events)


class TestAnthropicThinkingMapping:
    """§9 表第 3 列：anthropic 渠道 off 不发 thinking 块，其余映射预算。"""

    @pytest.mark.parametrize(
        ("level", "budget"), [("low", 2048), ("high", 8192), ("max", 16384)]
    )
    async def test_budget_mapping(
        self, monkeypatch: pytest.MonkeyPatch, level: str, budget: int
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        provider, captured = make_anthropic_provider(
            anthropic_sse(("message_stop", '{"type":"message_stop"}'))
        )
        request = CompletionRequest(
            model="claude", messages=[{"role": "user", "content": "q"}],
            thinking_level=level,  # type: ignore[arg-type]
        )
        await collect(provider, request)
        sent = json.loads(captured["request"].read())
        assert sent["thinking"] == {"type": "enabled", "budget_tokens": budget}
        # 工程约束：max_tokens 必须大于思考预算（API 要求），原 4096 不够 max
        assert sent["max_tokens"] == DEFAULT_MAX_TOKENS + budget

    async def test_off_sends_no_thinking_block(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        provider, captured = make_anthropic_provider(
            anthropic_sse(("message_stop", '{"type":"message_stop"}'))
        )
        request = CompletionRequest(
            model="claude", messages=[{"role": "user", "content": "q"}],
            thinking_level="off",
        )
        await collect(provider, request)
        sent = json.loads(captured["request"].read())
        assert "thinking" not in sent
        assert sent["max_tokens"] == DEFAULT_MAX_TOKENS

    async def test_thinking_delta_event(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """thinking_delta → ThoughtDelta；顺序先于 text_delta。"""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
        body = anthropic_sse(
            ("content_block_start", '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"逐步"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推理"}}'),
            ("content_block_delta", '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"结论"}}'),
            ("message_stop", '{"type":"message_stop"}'),
        )
        provider, _ = make_anthropic_provider(body)
        events = await collect(
            provider, CompletionRequest(model="claude", messages=[{"role": "user", "content": "q"}])
        )
        thoughts = [e.text for e in events if isinstance(e, ThoughtDelta)]
        assert thoughts == ["逐步", "推理"]
        assert "".join(thoughts) == "逐步推理"
        assert events[-1] == TurnCompleted("stop")


class TestMockRecordsThinking:
    """mock provider：忽略 thinking_level 但记录（演示/测试可观察）。"""

    async def test_mock_records_level(self) -> None:
        from qap.agents.providers.mock_provider import MockProvider

        provider = MockProvider()
        request = CompletionRequest(
            model="m", messages=[{"role": "user", "content": "q"}],
            metadata={"run_key": "r1", "agent_id": "echo"},
            thinking_level="low",  # type: ignore[arg-type]
        )
        events = await collect(provider, request)
        # 记录了请求的 thinking_level，且不改变事件行为（仍是回声）
        assert provider.request_log[-1]["thinking_level"] == "low"
        assert any(isinstance(e, TextDelta) for e in events)


# ---------- Runtime / SSE / API 层 ----------


class TestReasoningStreamRuntime:
    """Runtime：ThoughtDelta → message.reasoning SSE + Message.reasoning 累加。"""

    async def test_reasoning_events_before_delta_and_completed_carries_full(
        self,
    ) -> None:
        from qap.agents.providers.mock_provider import MockProvider
        from tests.test_runtime import Rig

        scripts = {
            "algorithm-designer": [
                [
                    ("thought", "分析：需要先建分子哈密顿量。"),
                    ("thought", "再参数化拟设。"),
                    ("text", "方案如下"),
                    ("tool", "query_hardware", {}),
                ],
                [("text", "收束。")],
            ],
        }
        rig = Rig()
        rig.provider = MockProvider(scripts)  # type: ignore[assignment]
        rig.runtime = type(rig.runtime)(
            rig.plugins, lambda ref: rig.provider, rig.tools, rig.bus
        )
        conversation = rig.new_conversation("algorithm-designer")
        sub = rig.bus.subscribe(conversation.id)
        assistant = await rig.chat(conversation, "设计 VQE")
        events = []
        while not sub.queue.empty():
            events.append(sub.queue.get_nowait())
        rig.bus.unsubscribe(sub)

        names = [e.name for e in events]
        reasoning_frames = [e for e in events if e.name == "message.reasoning"]
        delta_frames = [e for e in events if e.name == "message.delta"]
        # 不变量：思考在前（首个 reasoning 早于首个 delta）
        assert names.index("message.reasoning") < names.index("message.delta")
        # 增量拼接 == 全文 == Message.reasoning
        joined = "".join(e.data["delta"] for e in reasoning_frames)
        assert joined == "分析：需要先建分子哈密顿量。再参数化拟设。"
        assert assistant.reasoning == joined
        # 载荷契约：conversation_id/message_id/delta/seq
        assert all(f.data["message_id"] == assistant.id for f in reasoning_frames)
        assert all("seq" in f.data for f in reasoning_frames)
        # message.completed 带 reasoning 全文
        completed = next(e for e in events if e.name == "message.completed")
        assert completed.data["reasoning"] == joined


class TestPostMessageThinkingApi:
    """POST …/messages 的 model_ref / thinking_level 覆盖（契约 §5 v1.1）。"""

    @pytest.fixture()
    async def bundle(self, monkeypatch: pytest.MonkeyPatch) -> ClientBundle:
        monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
        instance = ClientBundle(make_test_config())
        yield instance
        await instance.app.state.qap.shutdown()
        await instance.http.aclose()

    async def test_invalid_thinking_level_422(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q", "thinking_level": "ultra"},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 422

    async def test_unknown_model_ref_422(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q", "model_ref": "ghost-channel"},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_failed"

    async def test_valid_overrides_accepted_and_priority(
        self, bundle: ClientBundle
    ) -> None:
        """消息级 thinking_level 生效（优先于渠道 default_thinking=high）。"""
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q", "model_ref": "default", "thinking_level": "low"},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 202
        await asyncio.sleep(0.2)
        log = bundle.state.providers["default"].request_log
        assert log, "mock provider 未收到请求"
        assert log[-1]["thinking_level"] == "low"

    async def test_channel_default_applies_when_message_level_absent(
        self, bundle: ClientBundle
    ) -> None:
        """无消息级覆盖 → 渠道 default_thinking（default 渠道缺省 high）。"""
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q"},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 202
        await asyncio.sleep(0.2)
        log = bundle.state.providers["default"].request_log
        assert log[-1]["thinking_level"] == "high"

    async def test_reasoning_frames_over_sse(self, bundle: ClientBundle) -> None:
        """会话 SSE：message.reasoning 帧先于 message.delta（思考先行）。"""
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations",
                json={"agent_id": "algorithm-designer"},
                headers=DEMO_HEADERS,
            )
        ).json()
        await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "带思考的方案"},
            headers=DEMO_HEADERS,
        )
        await asyncio.sleep(0.3)
        frames = await read_sse(
            bundle,
            f"/api/v1/conversations/{conversation['id']}/stream?after=0",
            until=lambda fs: any(f.event == "message.completed" for f in fs),
        )
        names = [f.event for f in frames]
        assert "message.reasoning" in names
        assert names.index("message.reasoning") < names.index("message.delta")
        completed = next(f for f in frames if f.event == "message.completed")
        assert completed.data["reasoning"]
        # 会话详情的 Message.reasoning 全文可见（契约 §4 v1.1）
        detail = (
            await bundle.http.get(
                f"/api/v1/conversations/{conversation['id']}", headers=DEMO_HEADERS
            )
        ).json()
        assistant = next(m for m in detail["messages"] if m["role"] == "assistant")
        assert assistant["reasoning"] == completed.data["reasoning"]
