"""V4 附件测试（契约 §5 v1.3 附件端点 + §9 Provider 行为）。

四类场景映射：
- 不变量：kind 判定规则（image/* → image；text/* 或文本扩展名 → text；
  其余 file）；size == 字节数；Message.attachments 缺省 []；同租户隔离。
- 非法输入拒绝：空文件/超 8MB/非 multipart → 422；未知/跨会话
  attachment_ids → 422。
- 负样本：跨租户读 raw → 404（与不存在同语义）。
- 可观察行为：上传 201 AttachmentMeta；raw 回原字节；发消息带附件后
  Provider 收到注入内容（openai text 追加 + image_url data URL、
  anthropic text 块 + image block；文本模型服务端错误经 SSE error 透传；
  mock 仅记录）。
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from tests.test_api_integration import DEMO_HEADERS, ClientBundle, make_test_config

OTHER_HEADERS = {"Authorization": "Bearer other-key"}
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@pytest.fixture()
async def bundle() -> ClientBundle:
    instance = ClientBundle(make_test_config())
    yield instance
    await instance.app.state.qap.shutdown()
    await instance.http.aclose()


async def make_conversation(bundle: ClientBundle) -> str:
    response = await bundle.http.post(
        "/api/v1/conversations", json={}, headers=DEMO_HEADERS
    )
    return response.json()["id"]


async def upload(
    bundle: ClientBundle, cid: str, name: str, content: bytes, mime: str
):
    return await bundle.http.post(
        f"/api/v1/conversations/{cid}/attachments",
        files={"file": (name, content, mime)},
        headers=DEMO_HEADERS,
    )


# ---------- 上传与 kind 判定 ----------

class TestUpload:
    async def test_image_upload_201(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        response = await upload(bundle, cid, "plot.png", PNG_MAGIC + b"rest", "image/png")
        assert response.status_code == 201
        meta = response.json()
        assert set(meta) == {"id", "name", "mime", "size", "kind"}
        assert meta["name"] == "plot.png"
        assert meta["mime"] == "image/png"
        assert meta["size"] == len(PNG_MAGIC) + 4
        assert meta["kind"] == "image"
        assert meta["id"].startswith("att-")

    @pytest.mark.parametrize(
        "name,mime",
        [
            ("notes.md", "text/markdown"),
            ("data.csv", "text/csv"),
            ("main.py", "text/x-python"),
            ("conf.toml", "application/octet-stream"),  # 扩展名兜底
            ("script.ts", "application/octet-stream"),
        ],
    )
    async def test_text_kind_by_mime_or_extension(
        self, bundle: ClientBundle, name: str, mime: str,
    ) -> None:
        cid = await make_conversation(bundle)
        response = await upload(bundle, cid, name, b"hello world", mime)
        assert response.status_code == 201
        assert response.json()["kind"] == "text"

    async def test_generic_file_kind(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        response = await upload(
            bundle, cid, "blob.bin", b"\x00\x01\x02", "application/octet-stream"
        )
        assert response.status_code == 201
        assert response.json()["kind"] == "file"

    async def test_empty_file_422(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        response = await upload(bundle, cid, "empty.txt", b"", "text/plain")
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_failed"

    async def test_over_8mb_422(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        response = await upload(
            bundle, cid, "big.bin", b"x" * (8 * 1024 * 1024 + 1),
            "application/octet-stream",
        )
        assert response.status_code == 422

    async def test_non_multipart_422(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        response = await bundle.http.post(
            f"/api/v1/conversations/{cid}/attachments",
            json={"file": "not-a-file"},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 422

    async def test_unknown_conversation_404(self, bundle: ClientBundle) -> None:
        response = await bundle.http.post(
            "/api/v1/conversations/c-999/attachments",
            files={"file": ("a.txt", b"hi", "text/plain")},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 404


# ---------- raw 读取与租户隔离 ----------

class TestRawRetrieval:
    async def test_raw_returns_original_bytes(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        payload = "你好，量子世界".encode("utf-8")
        meta = (
            await upload(bundle, cid, "hello.txt", payload, "text/plain")
        ).json()
        response = await bundle.http.get(
            f"/api/v1/attachments/{meta['id']}/raw", headers=DEMO_HEADERS
        )
        assert response.status_code == 200
        assert response.content == payload
        assert response.headers["content-type"].startswith("text/plain")

    async def test_raw_cross_tenant_404(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        meta = (
            await upload(bundle, cid, "secret.txt", b"private", "text/plain")
        ).json()
        response = await bundle.http.get(
            f"/api/v1/attachments/{meta['id']}/raw", headers=OTHER_HEADERS
        )
        assert response.status_code == 404

    async def test_raw_unknown_id_404(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get(
            "/api/v1/attachments/att-999/raw", headers=DEMO_HEADERS
        )
        assert response.status_code == 404


# ---------- Message.attachments 与 attachment_ids ----------

class TestMessageAttachments:
    async def test_message_attachments_default_empty(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "hi"}, headers=DEMO_HEADERS,
        )
        detail = (await bundle.http.get(
            f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS
        )).json()
        user_message = next(m for m in detail["messages"] if m["role"] == "user")
        assert user_message["attachments"] == []

    async def test_post_message_with_attachment_ids(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        meta_text = (
            await upload(bundle, cid, "notes.md", b"# notes", "text/markdown")
        ).json()
        meta_img = (
            await upload(bundle, cid, "plot.png", PNG_MAGIC, "image/png")
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "看下这两个文件", "attachment_ids": [meta_text["id"], meta_img["id"]]},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 202
        detail = (await bundle.http.get(
            f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS
        )).json()
        user_message = next(m for m in detail["messages"] if m["role"] == "user")
        assert [a["id"] for a in user_message["attachments"]] == [
            meta_text["id"], meta_img["id"],
        ]

    async def test_unknown_attachment_id_422(self, bundle: ClientBundle) -> None:
        cid = await make_conversation(bundle)
        response = await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "hi", "attachment_ids": ["att-999"]},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 422

    async def test_cross_conversation_attachment_id_422(self, bundle: ClientBundle) -> None:
        cid_a = await make_conversation(bundle)
        cid_b = await make_conversation(bundle)
        meta = (
            await upload(bundle, cid_a, "a.txt", b"a", "text/plain")
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{cid_b}/messages",
            json={"content": "hi", "attachment_ids": [meta["id"]]},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 422


# ---------- Provider 注入（openai/anthropic 适配器 + mock 记录） ----------

def openai_provider():
    """openai 适配器 + 捕获请求体的 MockTransport。"""
    from qap.agents.providers.factory import create_provider
    from qap.core.config import ModelConfig

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b'data: [DONE]\n\n',
        )

    transport = httpx.MockTransport(handler)
    provider = create_provider(
        ModelConfig(
            provider="openai", model="gpt-4o-mini",
            base_url="https://api.test/v1", api_key_env="TEST_KEY_X",
        ),
        transport=transport,
    )
    return provider, captured


def anthropic_provider():
    """anthropic 适配器 + 捕获请求体的 MockTransport。"""
    from qap.agents.providers.factory import create_provider
    from qap.core.config import ModelConfig

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b"event: message_stop\ndata: {}\n\n",
        )

    transport = httpx.MockTransport(handler)
    provider = create_provider(
        ModelConfig(
            provider="anthropic", model="claude-sonnet-4-5",
            base_url="https://api.test", api_key_env="TEST_KEY_A",
        ),
        transport=transport,
    )
    return provider, captured


def attachment_part(kind: str, **overrides):
    from qap.agents.providers.base import AttachmentPart

    base = dict(
        id="att-1", name="f", mime="text/plain" if kind == "text" else "image/png",
        kind=kind,
        text="ATTACHED TEXT CONTENT" if kind == "text" else None,
        data_base64=base64.b64encode(PNG_MAGIC).decode() if kind == "image" else None,
    )
    base.update(overrides)
    return AttachmentPart(**base)


class TestProviderAttachmentInjection:
    async def test_openai_text_attachment_injected_into_user_content(self) -> None:
        import os
        os.environ["TEST_KEY_X"] = "sk-test"
        try:
            provider, captured = openai_provider()
            from qap.agents.providers.base import CompletionRequest

            request = CompletionRequest(
                model="m",
                messages=[
                    {
                        "role": "user",
                        "content": "看附件",
                        "attachments": [attachment_part("text")],
                    }
                ],
            )
            async for _ in provider.stream(request):
                pass
            user_message = captured["payload"]["messages"][-1]
            assert user_message["role"] == "user"
            assert isinstance(user_message["content"], str)
            assert "看附件" in user_message["content"]
            assert "ATTACHED TEXT CONTENT" in user_message["content"]
            assert "f" in user_message["content"]  # 附件名标注
        finally:
            del os.environ["TEST_KEY_X"]

    async def test_openai_image_attachment_becomes_image_url_data_url(self) -> None:
        import os
        os.environ["TEST_KEY_X"] = "sk-test"
        try:
            provider, captured = openai_provider()
            from qap.agents.providers.base import AttachmentRequest  # noqa: F401
        except ImportError:
            pass
        from qap.agents.providers.base import CompletionRequest

        request = CompletionRequest(
            model="m",
            messages=[
                {
                    "role": "user",
                    "content": "看图",
                    "attachments": [attachment_part("image")],
                }
            ],
        )
        async for _ in provider.stream(request):
            pass
        user_message = captured["payload"]["messages"][-1]
        assert isinstance(user_message["content"], list)
        kinds = [part["type"] for part in user_message["content"]]
        assert "text" in kinds and "image_url" in kinds
        image_part = next(p for p in user_message["content"] if p["type"] == "image_url")
        assert image_part["image_url"]["url"].startswith("data:image/png;base64,")
        assert base64.b64encode(PNG_MAGIC).decode() in image_part["image_url"]["url"]

    async def test_anthropic_attachments_become_blocks(self) -> None:
        import os
        os.environ["TEST_KEY_A"] = "sk-test"
        try:
            provider, captured = anthropic_provider()
            from qap.agents.providers.base import CompletionRequest

            request = CompletionRequest(
                model="m",
                messages=[
                    {
                        "role": "user",
                        "content": "看全部",
                        "attachments": [
                            attachment_part("text"),
                            attachment_part("image"),
                        ],
                    }
                ],
            )
            async for _ in provider.stream(request):
                pass
            blocks = captured["payload"]["messages"][-1]["content"]
            assert isinstance(blocks, list)
            texts = [b for b in blocks if b["type"] == "text"]
            assert any("ATTACHED TEXT CONTENT" in b["text"] for b in texts)
            images = [b for b in blocks if b["type"] == "image"]
            assert len(images) == 1
            assert images[0]["source"]["type"] == "base64"
            assert images[0]["source"]["media_type"] == "image/png"
            assert images[0]["source"]["data"] == base64.b64encode(PNG_MAGIC).decode()
        finally:
            del os.environ["TEST_KEY_A"]

    async def test_text_truncated_to_200k_chars(self) -> None:
        import os
        os.environ["TEST_KEY_X"] = "sk-test"
        try:
            provider, captured = openai_provider()
            from qap.agents.providers.base import CompletionRequest

            request = CompletionRequest(
                model="m",
                messages=[
                    {
                        "role": "user",
                        "content": "query",  # 无 'x'，便于精确计数注入体
                        "attachments": [
                            attachment_part("text", text="x" * 250_000)
                        ],
                    }
                ],
            )
            async for _ in provider.stream(request):
                pass
            content = captured["payload"]["messages"][-1]["content"]
            # 200k 截断：标注行之后的注入体恰为 200_000 字符
            injected_body = content.split("]\n", 1)[1]
            assert len(injected_body) == 200_000
            assert set(injected_body) == {"x"}
            assert len(content) < 201_500
        finally:
            del os.environ["TEST_KEY_X"]

    async def test_file_kind_not_injected_as_content(self) -> None:
        import os
        os.environ["TEST_KEY_X"] = "sk-test"
        try:
            provider, captured = openai_provider()
            from qap.agents.providers.base import CompletionRequest

            request = CompletionRequest(
                model="m",
                messages=[
                    {
                        "role": "user",
                        "content": "hi",
                        "attachments": [attachment_part("file", mime="application/octet-stream", text=None)],
                    }
                ],
            )
            async for _ in provider.stream(request):
                pass
            user_message = captured["payload"]["messages"][-1]
            assert user_message["content"] == "hi"  # file 类不注入内容
        finally:
            del os.environ["TEST_KEY_X"]

    async def test_mock_provider_records_attachments_only(self) -> None:
        from qap.agents.providers.mock_provider import MockProvider
        from qap.agents.providers.base import CompletionRequest

        mock = MockProvider({})
        request = CompletionRequest(
            model="m",
            metadata={"run_key": "rk", "agent_id": "echo"},
            messages=[
                {
                    "role": "user",
                    "content": "hi",
                    "attachments": [attachment_part("text")],
                }
            ],
        )
        async for _ in mock.stream(request):
            pass
        logged = mock.request_log[-1]
        assert logged["attachments"] == [
            {"id": "att-1", "name": "f", "mime": "text/plain", "kind": "text"}
        ]


# ---------- 端到端：带附件发消息 → 注入 → SSE ----------

class TestAttachmentEndToEnd:
    async def test_openai_channel_with_attachment_message(
        self, bundle: ClientBundle, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """带附件的用户消息经 openai 渠道发出时请求体含注入内容；
        服务端错误（如文本模型拒图）经 SSE error 事件透传。"""
        monkeypatch.setenv("TEST_KEY_X", "sk-test")
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["payload"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                400,
                json={"error": {"code": 1210, "message": "image not supported"}},
            )

        from qap.agents.providers.factory import create_provider
        from qap.core.config import ModelConfig

        bundle.state.providers["default"] = create_provider(
            ModelConfig(
                provider="openai", model="text-model",
                base_url="https://api.test/v1", api_key_env="TEST_KEY_X",
            ),
            transport=httpx.MockTransport(handler),
        )
        cid = await make_conversation(bundle)
        meta = (
            await upload(bundle, cid, "plot.png", PNG_MAGIC, "image/png")
        ).json()
        posted = await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "看图", "attachment_ids": [meta["id"]]},
            headers=DEMO_HEADERS,
        )
        assert posted.status_code == 202
        # 文本模型拒图（4xx）→ ProviderErrorEvent → SSE error 事件透传
        from tests.test_api_integration import read_sse

        frames = await read_sse(
            bundle,
            f"/api/v1/conversations/{cid}/stream?after=0",
            until=lambda fs: any(f.event == "error" for f in fs),
            timeout=6.0,
        )
        error_frames = [f for f in frames if f.event == "error"]
        assert error_frames
        assert "400" in json.dumps(error_frames[0].data) or error_frames[0].data.get(
            "code"
        ) == "provider_error"
        # 注入确实发生（请求体是 content parts 列表且含 image_url）
        user_message = captured["payload"]["messages"][-1]
        assert isinstance(user_message["content"], list)
        assert any(p["type"] == "image_url" for p in user_message["content"])
