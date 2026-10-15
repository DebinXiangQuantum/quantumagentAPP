"""B1 配置覆盖层测试：config.toml ← config.local.toml 深合并（契约 §3 v1.1）。

四类场景映射：
- 不变量：本地文件缺失=正常（纯基底加载）；合并结果沿用既有 fail-fast
  结构校验；基底/本地 refs 被正确溯源。
- 非法输入拒绝：本地文件坏 TOML/未知键/非法 default_thinking。
- 负样本：QAP_CONFIG 指向不存在文件（既有行为保持）。
- 可观察行为：models 按键覆盖/新增、标量直接覆盖、list 整体替换；
  default_thinking 缺省 "high"；api_key_inline 只来自本地文件且
  resolve_api_key 优先内联。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from qap.core.config import ConfigError, load_config, load_config_with_sources
from qap.core.local_store import LocalConfigStore

from tests.test_config import VALID_CONFIG, write_config

#: 本地覆盖样例：覆盖 default 渠道字段 + 新增渠道 + 标量 + list 整体替换
LOCAL_OVERLAY = """
[server]
port = 9001

[models.default]
provider = "openai"
base_url = "https://local.test/v1"
api_key_env = "LOCAL_KEY"

[models."glm-5.3-flash"]
provider = "openai"
model = "glm-5.3-flash"
base_url = "https://open.bigmodel.cn/api/paas/v4"
api_key_env = "GLM_API_KEY"
timeout_seconds = 60
default_thinking = "low"
api_key_inline = "inline-secret-1"

[[hardware.nodes]]
id = "qpu-0"
kind = "qpu"
name = "Q0"
model = "transmon"
capacity = 1
"""


def write_pair(tmp_path: Path, base: str, local: str | None) -> Path:
    """写基底 config.toml（返回路径）与可选的 config.local.toml（同目录）。"""
    path = write_config(tmp_path, base)
    if local is not None:
        (tmp_path / "config.local.toml").write_text(local, encoding="utf-8")
    return path


class TestOverlaySemantics:
    def test_missing_local_file_is_normal(self, tmp_path: Path) -> None:
        """本地文件缺失 = 正常：等价于纯基底加载（契约 §3）。"""
        path = write_pair(tmp_path, VALID_CONFIG, None)
        loaded = load_config_with_sources(path)
        assert loaded.local_path is None
        assert loaded.base_model_refs == {"default", "claude"}
        assert loaded.local_model_refs == frozenset()
        assert loaded.config.server.port == 8000

    def test_models_key_override_and_addition(self, tmp_path: Path) -> None:
        """models 字典按键覆盖（字段级深合并）与新增渠道。"""
        path = write_pair(tmp_path, VALID_CONFIG, LOCAL_OVERLAY)
        loaded = load_config_with_sources(path)
        entry = loaded.config.models["default"]
        # 字段级覆盖：provider/base_url 被覆盖，model 继承基底
        assert entry.provider == "openai"
        assert entry.base_url == "https://local.test/v1"
        assert entry.api_key_env == "LOCAL_KEY"
        assert entry.model == "scripted-demo"
        # 新增渠道
        glm = loaded.config.models["glm-5.3-flash"]
        assert glm.timeout_seconds == 60
        assert glm.default_thinking == "low"
        assert glm.api_key_inline == "inline-secret-1"
        assert loaded.local_model_refs == frozenset({"default", "glm-5.3-flash"})
        assert "glm-5.3-flash" not in loaded.base_model_refs

    def test_scalar_override(self, tmp_path: Path) -> None:
        path = write_pair(tmp_path, VALID_CONFIG, LOCAL_OVERLAY)
        assert load_config(path).server.port == 9001

    def test_list_replaced_wholesale(self, tmp_path: Path) -> None:
        """list（hardware.nodes）整体替换——本地只留 1 个节点即只剩 1 个。"""
        path = write_pair(tmp_path, VALID_CONFIG, LOCAL_OVERLAY)
        loaded = load_config_with_sources(path)
        assert [n.id for n in loaded.config.hardware.nodes] == ["qpu-0"]

    def test_local_path_tracked_when_present(self, tmp_path: Path) -> None:
        path = write_pair(tmp_path, VALID_CONFIG, LOCAL_OVERLAY)
        loaded = load_config_with_sources(path)
        assert loaded.local_path == path.parent / "config.local.toml"
        assert loaded.local_path is not None and loaded.local_path.is_file()

    def test_qap_config_sibling_local_discovered(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """QAP_CONFIG 指定的文件其同目录 config.local.toml 同样参与合并。"""
        path = write_pair(tmp_path, VALID_CONFIG, LOCAL_OVERLAY)
        monkeypatch.setenv("QAP_CONFIG", str(path))
        loaded = load_config_with_sources()
        assert loaded.config.server.port == 9001


class TestThinkingDefaults:
    def test_default_thinking_defaults_to_high(self, tmp_path: Path) -> None:
        """缺省渠道 default_thinking = "high"（契约 §9 优先级末端）。"""
        config = load_config(write_config(tmp_path, VALID_CONFIG))
        assert config.models["default"].default_thinking == "high"
        assert config.models["claude"].default_thinking == "high"

    @pytest.mark.parametrize(
        ("label", "fragment"),
        [
            ("unknown_level", 'default_thinking = "ultra"'),
            ("empty_level", 'default_thinking = ""'),
            ("wrong_case", 'default_thinking = "OFF"'),
            ("wrong_type", "default_thinking = 1"),
            ("list_type", 'default_thinking = ["high"]'),
        ],
    )
    def test_invalid_default_thinking_rejected(
        self, tmp_path: Path, label: str, fragment: str
    ) -> None:
        """非法 default_thinking → fail-fast（ConfigError）。"""
        text = VALID_CONFIG.replace(
            'timeout_seconds = 120', f'timeout_seconds = 120\n{fragment}'
        )
        with pytest.raises(ConfigError):
            load_config(write_config(tmp_path, text))

    def test_repo_root_config_channels_load(self) -> None:
        """仓库根 config.toml（v1.6 真实契约样例：glm 渠道池，无 mock）可加载。"""
        repo_root = Path(__file__).resolve().parents[2]
        loaded = load_config_with_sources(repo_root / "config.toml")
        refs = set(loaded.config.models)
        assert {"claude", "glm-5.3", "glm-5.3-flash", "openai-compatible"} <= refs
        assert "mock" not in {
            entry.provider for entry in loaded.config.models.values()
        }
        assert loaded.config.agents.default_model_ref == "glm-5.3-flash"
        assert loaded.config.models["glm-5.3"].default_thinking == "high"
        assert loaded.config.models["glm-5.3-flash"].default_thinking == "low"


class TestInlineKeySemantics:
    def test_inline_key_preferred_over_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """resolve_api_key：本地内联密钥优先于环境变量（本地覆盖层更具体）。"""
        monkeypatch.setenv("GLM_API_KEY", "env-secret")
        path = write_pair(tmp_path, VALID_CONFIG, LOCAL_OVERLAY)
        config = load_config(path)
        assert config.resolve_api_key("glm-5.3-flash") == "inline-secret-1"

    def test_env_fallback_without_inline(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GLM_API_KEY", "env-secret")
        local = LOCAL_OVERLAY.replace('api_key_inline = "inline-secret-1"\n', "")
        path = write_pair(tmp_path, VALID_CONFIG, local)
        config = load_config(path)
        assert config.resolve_api_key("glm-5.3-flash") == "env-secret"

    def test_non_mock_channel_with_inline_key_only(self, tmp_path: Path) -> None:
        """openai 渠道有 base_url + api_key_inline（无 env 名）也合法。"""
        local = LOCAL_OVERLAY.replace('api_key_env = "GLM_API_KEY"', "")
        path = write_pair(tmp_path, VALID_CONFIG, local)
        config = load_config(path)
        assert config.models["glm-5.3-flash"].api_key_env is None


class TestOverlayFailFast:
    def test_bad_local_toml_rejected(self, tmp_path: Path) -> None:
        path = write_pair(tmp_path, VALID_CONFIG, "[server\nbroken =")
        with pytest.raises(ConfigError, match="invalid TOML"):
            load_config(path)

    def test_local_unknown_key_rejected(self, tmp_path: Path) -> None:
        """本地文件的未知键同样 fail-fast（深合并不豁免结构校验）。"""
        path = write_pair(tmp_path, VALID_CONFIG, '[server]\nextra_unknown = "x"')
        with pytest.raises(ConfigError):
            load_config(path)

    def test_local_invalid_merged_result_rejected(self, tmp_path: Path) -> None:
        """覆盖后悬空引用（本地删除了被引用模型）→ fail-fast。"""
        local = (
            '[models.default]\nprovider = "openai"\nmodel = "other"\n'
            'base_url = "http://test.invalid/v1"\napi_key_env = "QAP_TEST_KEY"'
        )
        # 真正的悬空：本地把 [agents] default_model_ref 指向不存在渠道。
        local += '\n\n[agents]\ndefault_model_ref = "ghost-ref"'
        path = write_pair(tmp_path, VALID_CONFIG, local)
        with pytest.raises(ConfigError, match="dangling"):
            load_config(path)


class TestPluginStateField:
    def test_plugin_state_parsed_from_local(self, tmp_path: Path) -> None:
        """[agents.plugin_state."<id>"] enabled → AgentsConfig.plugin_state。"""
        local = '\n[agents.plugin_state."echo"]\nenabled = false\n'
        path = write_pair(tmp_path, VALID_CONFIG, local)
        config = load_config(path)
        assert config.agents.plugin_state["echo"].enabled is False


class TestLocalStoreRoundTrip:
    """LocalConfigStore：config.local.toml 的读-改-写（B3/B4 的文件底座）。"""

    def test_upsert_and_delete_model(self, tmp_path: Path) -> None:
        store = LocalConfigStore(tmp_path / "config.local.toml")
        store.upsert_model("glm-5.3", {
            "provider": "openai", "model": "glm-5.3",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "api_key_env": "GLM_API_KEY", "timeout_seconds": 300.0,
            "default_thinking": "high",
        })
        assert store.load()["models"]["glm-5.3"]["timeout_seconds"] == 300.0
        # 键含点号必须带引号写出，回读后键保持原样
        store.upsert_model("glm-5.3-flash", {
            "provider": "openai", "model": "glm-5.3-flash",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "api_key_env": "GLM_API_KEY",
        })
        data = store.load()
        assert set(data["models"]) == {"glm-5.3", "glm-5.3-flash"}
        assert store.delete_model("glm-5.3") is True
        assert set(store.load()["models"]) == {"glm-5.3-flash"}
        assert store.delete_model("glm-5.3") is False  # 幂等删除

    def test_plugin_state_persisted(self, tmp_path: Path) -> None:
        store = LocalConfigStore(tmp_path / "config.local.toml")
        store.set_plugin_enabled("echo", False)
        assert store.load()["agents"]["plugin_state"]["echo"]["enabled"] is False
        store.set_plugin_enabled("echo", True)
        assert store.load()["agents"]["plugin_state"]["echo"]["enabled"] is True
        store.clear_plugin_state("echo")
        assert "plugin_state" not in store.load().get("agents", {})

    def test_unknown_sections_preserved(self, tmp_path: Path) -> None:
        """读-改-写不丢失手写的其他小节（注释会丢——已知权衡）。"""
        path = tmp_path / "config.local.toml"
        path.write_text('[server]\nport = 9001\n\n[tenancy]\ndefault_tenant = "demo"\n',
                        encoding="utf-8")
        store = LocalConfigStore(path)
        store.upsert_model("m1", {
            "provider": "openai", "model": "x",
            "base_url": "http://test.invalid/v1", "api_key_env": "X_KEY",
        })
        data = store.load()
        assert data["server"]["port"] == 9001
        assert data["tenancy"]["default_tenant"] == "demo"
        assert data["models"]["m1"]["provider"] == "openai"

    def test_missing_file_loads_empty(self, tmp_path: Path) -> None:
        store = LocalConfigStore(tmp_path / "config.local.toml")
        assert store.load() == {}
