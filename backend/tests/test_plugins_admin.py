"""B3 插件安装机制测试（契约 §8 v1.1：install/list/enable/uninstall 全生命周期）。

四类场景映射：
- 不变量：安装内容只落 plugins_dir（运行时目录，不入库）；启停状态持久化
  config.local.toml [agents.plugin_state]；builtin 插件不可卸载。
- 非法输入拒绝：缺 plugin.json → 422；qap.entry 无法导入 → 422 带原因；
  重名 → 409；DELETE builtin → 409。
- 负样本：启动扫描遇到坏插件 → 注册 broken 且平台不崩。
- 可观察行为：install → list（installed/enabled）→ /agents 可见 → disable
  → 不可见（状态落盘）→ enable → 可见 → uninstall → 消失；启动时按持久化
  状态恢复 disabled。
"""

from __future__ import annotations

import json
from pathlib import Path

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

#: 一个最小可用的外部插件源目录（plugin.json + Python 模块入口）
PLUGIN_JSON = {
    "name": "greeter",
    "version": "1.0.0",
    "description": "问好演示插件",
    "qap": {"entry": "greeter_plugin:make_plugin"},
}

PLUGIN_MODULE = '''"""外部演示插件：问好专家。"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class GreeterPlugin:
    id: str = "greeter"
    name: str = "问好专家"
    description: str = "向用户问好的最小演示插件"
    capabilities: tuple = ("greeting",)
    model_ref: str = "default"
    system_prompt: str = "你是问好专家：热情地向用户问好。"
    tools: tuple = ()


def make_plugin():
    return GreeterPlugin()
'''


def load_local_plugin_state(local_path: Path) -> dict:
    """从 config.local.toml 读 [agents.plugin_state]（等价深合并后的状态）。"""
    import tomllib

    if not local_path.is_file():
        return {}
    data = tomllib.loads(local_path.read_text(encoding="utf-8"))
    raw = data.get("agents", {}).get("plugin_state", {})
    from qap.core.config import PluginStateConfig

    return {pid: PluginStateConfig(**entry) for pid, entry in raw.items()}


def write_plugin_source(root: Path, dirname: str = "greeter") -> Path:
    """在 root 下写一个合法插件源目录，返回其路径。"""
    src = root / dirname
    src.mkdir(parents=True)
    (src / "plugin.json").write_text(
        json.dumps(PLUGIN_JSON, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (src / "greeter_plugin.py").write_text(PLUGIN_MODULE, encoding="utf-8")
    return src


def make_loaded_config(
    base_dir: Path,
    plugins_dir: Path,
    *,
    plugin_state: dict | None = None,
) -> LoadedConfig:
    """以临时目录为配置根组装 LoadedConfig（本地覆盖层同目录）。"""
    config = AppConfig(
        server=ServerConfig(host="127.0.0.1", port=8000, cors_origins=[]),
        models={"default": ModelConfig(provider="mock", model="scripted-demo")},
        agents=AgentsConfig(
            default_model_ref="default",
            plugins_dir=str(plugins_dir),
            builtin={
                "orchestrator": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "algorithm-designer": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "calibration": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "echo": BuiltinAgentConfig(enabled=True, model_ref="default"),
            },
            plugin_state=plugin_state or {},
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
            tenants=[TenantConfig(id="demo", name="Demo", api_key="demo-key",
                                  max_concurrent_tasks=2, max_messages_per_day=100,
                                  role="admin")],
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
async def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """插件管理测试环境：bundle + plugins_dir + source 根 + 本地存储。"""
    monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
    plugins_dir = tmp_path / "plugins"
    source_root = tmp_path / "sources"
    source_root.mkdir()
    app = create_app(make_loaded_config(tmp_path, plugins_dir))
    import httpx

    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )
    yield {
        "app": app,
        "http": client,
        "plugins_dir": plugins_dir,
        "sources": source_root,
        "tmp_path": tmp_path,
    }
    await app.state.qap.shutdown()
    await client.aclose()


class TestInstallLifecycle:
    async def test_install_list_agents_visible(self, env: dict) -> None:
        src = write_plugin_source(env["sources"])
        response = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)},
            headers=DEMO_HEADERS,
        )
        assert response.status_code == 201, response.text
        record = response.json()
        assert record["id"] == "greeter"
        assert record["enabled"] is True
        assert record["builtin"] is False
        assert record["broken"] is None
        # 安装目录 = plugins_dir/<dirname>（运行时目录，不入库）
        assert (env["plugins_dir"] / "greeter" / "plugin.json").is_file()
        # 管理列表：builtin + installed
        listed = (
            await env["http"].get("/api/v1/admin/plugins", headers=DEMO_HEADERS)
        ).json()["plugins"]
        ids = {p["id"] for p in listed}
        assert {"orchestrator", "algorithm-designer", "echo", "greeter"} <= ids
        greeter = next(p for p in listed if p["id"] == "greeter")
        assert greeter["builtin"] is False and greeter["enabled"] is True
        echo = next(p for p in listed if p["id"] == "echo")
        assert echo["builtin"] is True
        # /agents 立即可见（可直接对话）
        agents = (await env["http"].get("/api/v1/agents", headers=DEMO_HEADERS)).json()
        assert "greeter" in {a["id"] for a in agents}

    async def test_duplicate_id_409(self, env: dict) -> None:
        src = write_plugin_source(env["sources"])
        first = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        assert first.status_code == 201
        dup = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        assert dup.status_code == 409
        assert dup.json()["error"]["code"] == "conflict"

    async def test_missing_manifest_422(self, env: dict) -> None:
        bad = env["sources"] / "no-manifest"
        bad.mkdir()
        (bad / " stray.txt").write_text("not a plugin", encoding="utf-8")
        response = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(bad)}, headers=DEMO_HEADERS,
        )
        assert response.status_code == 422
        assert "plugin.json" in response.json()["error"]["message"]

    async def test_bad_entry_422_with_reason(self, env: dict) -> None:
        src = env["sources"] / "bad-entry"
        src.mkdir()
        (src / "plugin.json").write_text(
            json.dumps({"name": "bad", "version": "1", "qap": {"entry": "missing_mod:factory"}}),
            encoding="utf-8",
        )
        response = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        assert response.status_code == 422
        assert "entry" in response.json()["error"]["message"] or "module" in response.json()["error"]["message"]

    async def test_source_path_not_found_422(self, env: dict) -> None:
        response = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(env["tmp_path"] / "ghost")}, headers=DEMO_HEADERS,
        )
        assert response.status_code == 422

    async def test_disable_enable_roundtrip(self, env: dict) -> None:
        src = write_plugin_source(env["sources"])
        await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        # disable：200 + 落盘 config.local.toml
        disabled = await env["http"].put(
            "/api/v1/admin/plugins/greeter", json={"enabled": False}, headers=DEMO_HEADERS
        )
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False
        store = LocalConfigStore(env["tmp_path"] / "config.local.toml")
        assert store.load()["agents"]["plugin_state"]["greeter"]["enabled"] is False
        agents = (await env["http"].get("/api/v1/agents", headers=DEMO_HEADERS)).json()
        assert "greeter" not in {a["id"] for a in agents}  # 运行时即时摘除
        # enable：恢复
        enabled = await env["http"].put(
            "/api/v1/admin/plugins/greeter", json={"enabled": True}, headers=DEMO_HEADERS
        )
        assert enabled.status_code == 200
        agents = (await env["http"].get("/api/v1/agents", headers=DEMO_HEADERS)).json()
        assert "greeter" in {a["id"] for a in agents}

    async def test_uninstall_removes_dir_and_state(self, env: dict) -> None:
        src = write_plugin_source(env["sources"])
        await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        await env["http"].put(
            "/api/v1/admin/plugins/greeter", json={"enabled": False}, headers=DEMO_HEADERS
        )
        removed = await env["http"].delete(
            "/api/v1/admin/plugins/greeter", headers=DEMO_HEADERS
        )
        assert removed.status_code == 204
        assert not (env["plugins_dir"] / "greeter").exists()  # 目录已卸载
        store = LocalConfigStore(env["tmp_path"] / "config.local.toml")
        state = store.load().get("agents", {}).get("plugin_state", {})
        assert "greeter" not in state  # 状态已清理
        agents = (await env["http"].get("/api/v1/agents", headers=DEMO_HEADERS)).json()
        assert "greeter" not in {a["id"] for a in agents}
        # 卸载后可重装
        again = await env["http"].post(
            "/api/v1/admin/plugins/install",
            json={"source_path": str(src)}, headers=DEMO_HEADERS,
        )
        assert again.status_code == 201

    async def test_delete_builtin_409(self, env: dict) -> None:
        response = await env["http"].delete(
            "/api/v1/admin/plugins/echo", headers=DEMO_HEADERS
        )
        assert response.status_code == 409

    async def test_unknown_plugin_404(self, env: dict) -> None:
        response = await env["http"].put(
            "/api/v1/admin/plugins/ghost", json={"enabled": True}, headers=DEMO_HEADERS
        )
        assert response.status_code == 404
        response = await env["http"].delete(
            "/api/v1/admin/plugins/ghost", headers=DEMO_HEADERS
        )
        assert response.status_code == 404

    async def test_admin_requires_auth(self, env: dict) -> None:
        response = await env["http"].get("/api/v1/admin/plugins")
        assert response.status_code == 401


class TestStartupScan:
    async def test_scan_restores_state_and_records_broken(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """启动扫描：好插件按持久化状态恢复（disabled）；坏插件注册 broken
        且平台不崩（§8）。"""
        monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
        plugins_dir = tmp_path / "plugins"
        plugins_dir.mkdir()
        # 好插件（直接放安装目录——模拟上次安装的存量）
        write_plugin_source(tmp_path, dirname=str(plugins_dir / "greeter"))
        # 坏插件：manifest 声明的入口模块不存在
        broken = plugins_dir / "broken"
        broken.mkdir()
        (broken / "plugin.json").write_text(
            json.dumps({"name": "broken", "version": "1",
                        "qap": {"entry": "no_such_module:factory"}}),
            encoding="utf-8",
        )
        # 持久化状态：greeter disabled（生产路径经 load_config_with_sources
        # 深合并进 AgentsConfig.plugin_state；此处直接注入等价状态）
        LocalConfigStore(tmp_path / "config.local.toml").set_plugin_enabled("greeter", False)
        local_disabled = load_local_plugin_state(tmp_path / "config.local.toml")

        app = create_app(make_loaded_config(tmp_path, plugins_dir, plugin_state=local_disabled))
        import httpx

        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        )
        try:
            listed = (await client.get("/api/v1/admin/plugins", headers=DEMO_HEADERS)).json()["plugins"]
            greeter = next(p for p in listed if p["id"] == "greeter")
            assert greeter["enabled"] is False  # 按持久化状态恢复
            broken_entry = next(p for p in listed if p["id"] == "broken")
            assert broken_entry["broken"], "坏插件应注册 broken 原因"
            # 平台不崩：agents 清单正常，greeter 被禁用不出现
            agents = (await client.get("/api/v1/agents", headers=DEMO_HEADERS)).json()
            assert "greeter" not in {a["id"] for a in agents}
            assert "echo" in {a["id"] for a in agents}
        finally:
            await app.state.qap.shutdown()
            await client.aclose()
