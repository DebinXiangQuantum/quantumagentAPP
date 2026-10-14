"""B4 管理 API（渠道池）测试（契约 §5 v1.1：ModelChannel CRUD 脱敏）。

四类场景映射：
- 不变量：GET 绝不回传密钥明文（api_key_inline 只体现为 has_api_key）；
  内联密钥只落 config.local.toml（gitignored），基底渠道不可删。
- 非法输入拒绝：provider/default_thinking 非法 → 422；缺 model → 422；
  openai 缺 base_url → 422。
- 负样本：DELETE 基底渠道 → 409；DELETE 被 agents.default_model_ref 引用
  的渠道 → 409；未知渠道 DELETE → 404；无鉴权 → 401。
- 可观察行为：PUT 创建/覆盖渠道 → config.local.toml 落盘 + 运行时即时
  可用（POST messages model_ref 走新渠道）；DELETE 本地渠道 → 204 + 移除。
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from qap.core.config import (
    AgentsConfig,
    AppConfig,
    BuiltinAgentConfig,
    HardwareConfig,
    HardwareNodeConfig,
    LoadedConfig,
    ModelConfig,
    SchedulerConfig,
    ServerConfig,
    TenancyConfig,
    TenantConfig,
)
from qap.core.local_store import LocalConfigStore
from qap.main import create_app

from tests.test_api_integration import DEMO_HEADERS

GLM_CHANNEL = {
    "provider": "openai",
    "model": "glm-5.3",
    "base_url": "https://open.bigmodel.cn/api/paas/v4",
    "api_key_env": "GLM_API_KEY",
    "timeout_seconds": 300.0,
    "default_thinking": "high",
}


def make_loaded_config(base_dir: Path) -> LoadedConfig:
    """基底：default(mock) + glm-5.3(openai) 双渠道。"""
    config = AppConfig(
        server=ServerConfig(host="127.0.0.1", port=8000, cors_origins=[]),
        models={
            "default": ModelConfig(provider="mock", model="scripted-demo"),
            "glm-5.3": ModelConfig.model_validate(GLM_CHANNEL),
        },
        agents=AgentsConfig(
            default_model_ref="default",
            plugins_dir="plugins",
            builtin={
                "orchestrator": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "echo": BuiltinAgentConfig(enabled=True, model_ref="default"),
            },
        ),
        hardware=HardwareConfig(
            simulated=False,
            tick_seconds=60.0,
            nodes=[
                HardwareNodeConfig(id="qpu-0", kind="qpu", name="Q", model="m", capacity=1),
                HardwareNodeConfig(id="cpu-0", kind="cpu", name="C", model="m", capacity=4),
            ],
        ),
        scheduler=SchedulerConfig(max_parallel_steps=4, step_timeout_seconds=10.0,
                                  retry_failed_steps=False),
        tenancy=TenancyConfig(
            default_tenant="demo",
            # v1.2：admin 端点测试租户需 admin 角色（require_admin 守卫）
            tenants=[
                TenantConfig(id="demo", name="Demo", api_key="demo-key",
                             max_concurrent_tasks=2, max_messages_per_day=100,
                             role="admin"),
                TenantConfig(id="user1", name="User", api_key="user-key",
                             max_concurrent_tasks=1, max_messages_per_day=100,
                             role="user"),
            ],
        ),
    )
    return LoadedConfig(
        config=config,
        base_path=base_dir / "config.toml",
        local_path=None,
        base_model_refs=frozenset(config.models),
        local_model_refs=frozenset(),
    )


@pytest.fixture()
async def bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
    monkeypatch.delenv("GLM_API_KEY", raising=False)
    app = create_app(make_loaded_config(tmp_path))
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )
    yield {"app": app, "http": client, "tmp_path": tmp_path}
    await app.state.qap.shutdown()
    await client.aclose()


class TestGetModels:
    async def test_list_shape_and_no_secrets(self, bundle: dict) -> None:
        response = await bundle["http"].get("/api/v1/admin/models", headers=DEMO_HEADERS)
        assert response.status_code == 200
        models = response.json()["models"]
        refs = {m["ref"] for m in models}
        assert refs == {"default", "glm-5.3"}
        glm = next(m for m in models if m["ref"] == "glm-5.3")
        assert set(glm) == {
            "ref", "provider", "model", "base_url", "api_key_env",
            "has_api_key", "default_thinking", "timeout_seconds",
        }
        assert glm["api_key_env"] == "GLM_API_KEY"
        assert glm["default_thinking"] == "high"
        # 环境变量缺失 → has_api_key False；响应绝无密钥明文字段
        assert glm["has_api_key"] is False
        assert "api_key_inline" not in glm

    async def test_has_api_key_true_when_env_set(
        self, bundle: dict, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GLM_API_KEY", "sk-live-from-env")
        response = await bundle["http"].get("/api/v1/admin/models", headers=DEMO_HEADERS)
        glm = next(m for m in response.json()["models"] if m["ref"] == "glm-5.3")
        assert glm["has_api_key"] is True

    async def test_requires_auth(self, bundle: dict) -> None:
        response = await bundle["http"].get("/api/v1/admin/models")
        assert response.status_code == 401


class TestPutModels:
    async def test_create_local_channel(self, bundle: dict) -> None:
        payload = {
            "provider": "mock",
            "model": "scripted-alt",
            "default_thinking": "low",
        }
        response = await bundle["http"].put(
            "/api/v1/admin/models/alt-mock", json=payload, headers=DEMO_HEADERS
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ref"] == "alt-mock"
        assert body["has_api_key"] is False
        # 落盘 config.local.toml
        store = LocalConfigStore(bundle["tmp_path"] / "config.local.toml")
        assert store.load()["models"]["alt-mock"]["model"] == "scripted-alt"
        # GET 可见 + 运行时即时可用（发消息走新渠道）
        listed = (
            await bundle["http"].get("/api/v1/admin/models", headers=DEMO_HEADERS)
        ).json()["models"]
        assert "alt-mock" in {m["ref"] for m in listed}
        conversation = (
            await bundle["http"].post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        posted = await bundle["http"].post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q", "model_ref": "alt-mock"},
            headers=DEMO_HEADERS,
        )
        assert posted.status_code == 202

    async def test_inline_key_never_echoed(self, bundle: dict) -> None:
        """PUT api_key_inline：只写本地文件；响应只体现 has_api_key=true。"""
        payload = {
            "provider": "openai",
            "model": "glm-5.3-flash",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "api_key_inline": "sk-plaintext-secret",
            "default_thinking": "low",
        }
        response = await bundle["http"].put(
            "/api/v1/admin/models/glm-5.3-flash", json=payload, headers=DEMO_HEADERS
        )
        assert response.status_code == 200
        body = response.json()
        assert body["has_api_key"] is True
        assert "sk-plaintext-secret" not in json.dumps(body)  # 脱敏
        # 明文只落 gitignored 本地文件
        raw = (bundle["tmp_path"] / "config.local.toml").read_text(encoding="utf-8")
        assert "sk-plaintext-secret" in raw
        # GET 亦不回传明文
        listed = (
            await bundle["http"].get("/api/v1/admin/models", headers=DEMO_HEADERS)
        ).json()
        assert "sk-plaintext-secret" not in json.dumps(listed)
        flash = next(m for m in listed["models"] if m["ref"] == "glm-5.3-flash")
        assert flash["has_api_key"] is True

    async def test_override_base_channel(self, bundle: dict) -> None:
        """PUT 覆盖基底渠道（写本地覆盖层；基底本身不动）。"""
        payload = {**GLM_CHANNEL, "timeout_seconds": 60.0}
        response = await bundle["http"].put(
            "/api/v1/admin/models/glm-5.3", json=payload, headers=DEMO_HEADERS
        )
        assert response.status_code == 200
        assert response.json()["timeout_seconds"] == 60.0
        store = LocalConfigStore(bundle["tmp_path"] / "config.local.toml")
        assert store.load()["models"]["glm-5.3"]["timeout_seconds"] == 60.0

    @pytest.mark.parametrize(
        ("label", "payload"),
        [
            ("bad_provider", {"provider": "azure", "model": "m"}),
            ("bad_thinking", {"provider": "mock", "model": "m", "default_thinking": "ultra"}),
            ("missing_model", {"provider": "mock"}),
            (
                "openai_without_base_url",
                {"provider": "openai", "model": "m", "api_key_env": "X"},
            ),
            ("bad_timeout", {"provider": "mock", "model": "m", "timeout_seconds": -1}),
        ],
    )
    async def test_invalid_inputs_422(self, bundle: dict, label: str, payload: dict) -> None:
        response = await bundle["http"].put(
            "/api/v1/admin/models/bad-channel", json=payload, headers=DEMO_HEADERS
        )
        assert response.status_code == 422, label


class TestDeleteModels:
    async def test_delete_base_channel_409(self, bundle: dict) -> None:
        response = await bundle["http"].delete(
            "/api/v1/admin/models/glm-5.3", headers=DEMO_HEADERS
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "conflict"

    async def test_delete_referenced_channel_409(self, bundle: dict) -> None:
        """被插件 model_ref 引用的本地渠道：删除会造成悬空引用 → 409。"""
        # 造一个绑定 alt-mock 渠道的外部插件并安装
        await bundle["http"].put(
            "/api/v1/admin/models/alt-mock",
            json={"provider": "mock", "model": "x"},
            headers=DEMO_HEADERS,
        )
        src = bundle["tmp_path"] / "src" / "bound"
        src.mkdir(parents=True)
        (src / "plugin.json").write_text(
            json.dumps({"name": "bound", "version": "1",
                        "qap": {"entry": "p:make_plugin"}}),
            encoding="utf-8",
        )
        (src / "p.py").write_text(
            "from dataclasses import dataclass\n"
            "@dataclass(frozen=True)\n"
            "class P:\n"
            "    id: str = 'bound'\n    name: str = '绑定插件'\n"
            "    description: str = '绑定 alt-mock 渠道'\n"
            "    capabilities: tuple = ()\n    model_ref: str = 'alt-mock'\n"
            "    system_prompt: str = 'x'\n    tools: tuple = ()\n"
            "def make_plugin(): return P()\n",
            encoding="utf-8",
        )
        installed = await bundle["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        assert installed.status_code == 201
        response = await bundle["http"].delete(
            "/api/v1/admin/models/alt-mock", headers=DEMO_HEADERS
        )
        assert response.status_code == 409
        assert "bound" in response.json()["error"]["message"]  # 原因指向引用者

    async def test_delete_local_channel_204(self, bundle: dict) -> None:
        await bundle["http"].put(
            "/api/v1/admin/models/alt-mock",
            json={"provider": "mock", "model": "x"},
            headers=DEMO_HEADERS,
        )
        response = await bundle["http"].delete(
            "/api/v1/admin/models/alt-mock", headers=DEMO_HEADERS
        )
        assert response.status_code == 204
        listed = (
            await bundle["http"].get("/api/v1/admin/models", headers=DEMO_HEADERS)
        ).json()["models"]
        assert "alt-mock" not in {m["ref"] for m in listed}
        store = LocalConfigStore(bundle["tmp_path"] / "config.local.toml")
        assert "alt-mock" not in store.load().get("models", {})
        # 运行时同步摘除：再用该渠道发消息 → 422
        conversation = (
            await bundle["http"].post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        posted = await bundle["http"].post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q", "model_ref": "alt-mock"},
            headers=DEMO_HEADERS,
        )
        assert posted.status_code == 422

    async def test_delete_unknown_channel_404(self, bundle: dict) -> None:
        response = await bundle["http"].delete(
            "/api/v1/admin/models/ghost", headers=DEMO_HEADERS
        )
        assert response.status_code == 404


USER_HEADERS = {"Authorization": "Bearer user-key"}


class TestUserModelSelectorList:
    """GET /api/v1/models（v1.3）：任意角色可读的模型选择器列表。

    与 /admin/models 的区别：不含 base_url / api_key_env / timeout 等管理细节，
    仅暴露选择器所需字段（ref/provider/model/default_thinking/has_api_key）。
    """

    async def test_user_role_can_list_selector_models(self, bundle: dict) -> None:
        response = await bundle["http"].get("/api/v1/models", headers=USER_HEADERS)
        assert response.status_code == 200
        models = response.json()["models"]
        refs = {m["ref"] for m in models}
        assert refs == {"default", "glm-5.3"}
        for m in models:
            # 选择器字段在位；管理字段绝不出现（base_url/密钥线索）
            assert {"ref", "provider", "model", "default_thinking", "has_api_key"} <= set(m)
            assert "base_url" not in m
            assert "api_key_env" not in m
            assert "api_key_inline" not in m

    async def test_admin_role_also_ok_and_unauth_401(self, bundle: dict) -> None:
        ok = await bundle["http"].get("/api/v1/models", headers=DEMO_HEADERS)
        assert ok.status_code == 200
        anon = await bundle["http"].get("/api/v1/models")
        assert anon.status_code == 401
