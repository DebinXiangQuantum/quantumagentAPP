"""S1 配置加载器测试：路径解析、fail-fast 校验、密钥规则（契约 §3）。

四类场景映射：
- 不变量：合法仓库根配置可加载且引用完整。
- 非法输入拒绝：缺键/类型错/未知 provider/未知 kind/负容量/悬空引用/未知键。
- 负样本：QAP_CONFIG 指向不存在文件、TOML 语法错误。
- 可观察行为：demo-key 被 QAP_DEMO_API_KEY 覆盖；密钥只从环境变量读。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from qap.core.config import (
    DEMO_API_KEY_ENV,
    ConfigError,
    load_config,
)

#: 与仓库根 config.toml 等价的最小合法配置（测试基准，字段含义见契约 §3）。
#: v1.6：产品无 mock 渠道——default 也是真实 provider（openai）形状，
#: base_url 指向测试域、密钥读不存在的环境变量（结构合法即可加载）。
VALID_CONFIG = """
[server]
host = "127.0.0.1"
port = 8000
cors_origins = ["http://localhost:5173"]

[models.default]
provider = "openai"
model = "scripted-demo"
base_url = "http://test.invalid/v1"
api_key_env = "QAP_TEST_KEY"

[models.claude]
provider = "anthropic"
model = "claude-sonnet-4-5"
base_url = "https://api.anthropic.com"
api_key_env = "ANTHROPIC_API_KEY"
timeout_seconds = 120

[agents]
default_model_ref = "default"
plugins_dir = ""

[agents.builtin.echo]
enabled = true
model_ref = "default"

[hardware]
simulated = true
tick_seconds = 2.0

[[hardware.nodes]]
id = "qpu-0"
kind = "qpu"
name = "Q0"
model = "transmon"
capacity = 1

[[hardware.nodes]]
id = "cpu-0"
kind = "cpu"
name = "C0"
model = "EPYC"
capacity = 4

[scheduler]
max_parallel_steps = 4
step_timeout_seconds = 60
retry_failed_steps = false

[tenancy]
default_tenant = "demo"

[[tenancy.tenants]]
id = "demo"
name = "Demo"
api_key = "demo-key"
max_concurrent_tasks = 2
max_messages_per_day = 1000
"""


def write_config(tmp_path: Path, text: str) -> Path:
    """把配置文本写入临时文件并返回路径（避免每个用例重复样板）。"""
    path = tmp_path / "config.toml"
    path.write_text(text, encoding="utf-8")
    return path


def mutate(text: str, old: str, new: str) -> str:
    """替换 VALID_CONFIG 中的一个片段；片段不存在时让测试直接失败。"""
    assert old in text, f"mutation target not found: {old!r}"
    return text.replace(old, new, 1)


class TestValidConfig:
    def test_loads_repo_root_config(self) -> None:
        """仓库根 config.toml（真实契约样例）必须原样可加载。"""
        repo_root = Path(__file__).resolve().parents[2]
        config = load_config(repo_root / "config.toml")
        assert config.server.port == 8000
        # v1.6：默认渠道必须是真实 provider（glm-5.3-flash = openai 形状）
        assert config.agents.default_model_ref in ("glm-5.3", "glm-5.3-flash")  # local 可覆盖
        assert config.models["glm-5.3-flash"].provider == "openai"
        assert all(
            entry.provider in ("openai", "anthropic")
            for entry in config.models.values()
        )
        # config.local.toml（gitignored）覆盖 nodes 列表为真实机器——
        # 本机为 gpu-a100/gpu-h100（logicalcloud 模式 QPU 实拉），qpu 节点被忽略
        assert len(config.hardware.nodes) >= 1
        assert config.tenancy.default_tenant == "demo"

    def test_loads_repo_root_builtin_default_alias(self) -> None:
        """仓库根 config 的 builtin model_ref="default" 为保留别名（运行时
        解析为 default_model_ref）——别名引用不算悬空（v1.6 修订）。"""
        repo_root = Path(__file__).resolve().parents[2]
        config = load_config(repo_root / "config.toml")
        assert config.agents.builtin["orchestrator"].model_ref == "default"
        assert config.agents.default_model_ref in config.models

    def test_builtin_default_alias_dangling_when_base_ref_missing(
        self, tmp_path: Path
    ) -> None:
        """负样本：default_model_ref 悬空时，builtin 的 "default" 别名同样
        悬空（别名不是逃逸口）。"""
        text = mutate(
            VALID_CONFIG, 'default_model_ref = "default"', 'default_model_ref = "ghost"'
        )
        with pytest.raises(ConfigError, match="dangling"):
            load_config(write_config(tmp_path, text))

    def test_loads_minimal_valid_config(self, tmp_path: Path) -> None:
        config = load_config(write_config(tmp_path, VALID_CONFIG))
        assert config.agents.default_model_ref == "default"
        assert config.scheduler.step_timeout_seconds == 60

    def test_qap_config_env_selects_path(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = write_config(tmp_path, VALID_CONFIG)
        monkeypatch.setenv("QAP_CONFIG", str(path))
        assert load_config().server.host == "127.0.0.1"

    def test_cwd_fallback_finds_repo_config(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """未设 QAP_CONFIG 时自 CWD 向上探测仓库根 config.toml。"""
        repo_root = Path(__file__).resolve().parents[2]
        monkeypatch.delenv("QAP_CONFIG", raising=False)
        monkeypatch.chdir(repo_root / "backend" / "tests")  # 仓库内任意深度的子目录
        assert load_config().server.port == 8000


class TestSecretHandling:
    def test_demo_key_override(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """api_key == 'demo-key' 的租户密钥被 QAP_DEMO_API_KEY 覆盖。"""
        monkeypatch.setenv(DEMO_API_KEY_ENV, "real-secret-42")
        config = load_config(write_config(tmp_path, VALID_CONFIG))
        assert config.tenancy.tenants[0].api_key == "real-secret-42"

    def test_non_demo_key_not_overridden(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """非占位密钥不受 QAP_DEMO_API_KEY 影响（避免误改真实配置）。"""
        text = mutate(VALID_CONFIG, 'api_key = "demo-key"', 'api_key = "custom-key"')
        monkeypatch.setenv(DEMO_API_KEY_ENV, "real-secret-42")
        config = load_config(write_config(tmp_path, text))
        assert config.tenancy.tenants[0].api_key == "custom-key"

    def test_api_key_read_only_from_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """resolve_api_key 只读 api_key_env 指向的环境变量，缺失返回 None。"""
        config = load_config(write_config(tmp_path, VALID_CONFIG))
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        assert config.resolve_api_key("claude") is None
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        assert config.resolve_api_key("claude") == "sk-test"
        monkeypatch.delenv("QAP_TEST_KEY", raising=False)
        assert config.resolve_api_key("default") is None  # 环境变量未设置
        monkeypatch.setenv("QAP_TEST_KEY", "sk-test-2")
        assert config.resolve_api_key("default") == "sk-test-2"


class TestFailFast:
    """非法输入拒绝：每一类畸形配置都必须在启动期抛 ConfigError。"""

    @pytest.mark.parametrize(
        ("label", "old", "new"),
        [
            ("missing_server_port", 'port = 8000', ""),
            ("wrong_type_port", 'port = 8000', 'port = "not-a-number"'),
            ("unknown_provider", 'provider = "anthropic"', 'provider = "azure"'),
            ("unknown_node_kind", 'kind = "qpu"', 'kind = "tpu"'),
            ("negative_capacity", "capacity = 1", "capacity = -1"),
            ("zero_capacity", "capacity = 4", "capacity = 0"),
            ("negative_timeout", "step_timeout_seconds = 60", "step_timeout_seconds = -5"),
            ("unknown_top_key", "[server]", "[server]\nextra_table_marker = true"),
            ("duplicate_node_id", 'id = "cpu-0"', 'id = "qpu-0"'),
            ("dangling_model_ref", 'default_model_ref = "default"', 'default_model_ref = "ghost"'),
            ("dangling_builtin_ref", 'model_ref = "default"', 'model_ref = "ghost"'),
            ("dangling_default_tenant", 'default_tenant = "demo"', 'default_tenant = "ghost"'),
            (
                # 把 claude 改成 openai provider 且删掉连接参数 → 必须拒绝
                "openai_without_base_url",
                '[models.claude]\nprovider = "anthropic"\nmodel = "claude-sonnet-4-5"\n'
                'base_url = "https://api.anthropic.com"\napi_key_env = "ANTHROPIC_API_KEY"',
                '[models.claude]\nprovider = "openai"\nmodel = "gpt-4o-mini"',
            ),
            (
                # v1.6：mock 渠道整体移除——配置层明确拒绝并指向契约
                "removed_mock_provider",
                '[models.default]\nprovider = "openai"\nmodel = "scripted-demo"\n'
                'base_url = "http://test.invalid/v1"\napi_key_env = "QAP_TEST_KEY"',
                '[models.default]\nprovider = "mock"\nmodel = "scripted-demo"',
            ),
            (
                # mock 渠道即使补齐 base_url/密钥也拒绝（不是缺参问题）
                "removed_mock_provider_full_shape",
                'provider = "openai"\nmodel = "scripted-demo"',
                'provider = "mock"\nmodel = "scripted-demo"',
            ),
            ("empty_models", "[models.default]", "[models.ghost_placeholder]"),
            ("blank_api_key_env", 'api_key_env = "ANTHROPIC_API_KEY"', 'api_key_env = ""'),
        ],
    )
    def test_malformed_config_rejected(
        self, tmp_path: Path, label: str, old: str, new: str
    ) -> None:
        path = write_config(tmp_path, mutate(VALID_CONFIG, old, new))
        with pytest.raises(ConfigError):
            load_config(path)

    def test_mock_provider_rejected_with_v16_pointer(self, tmp_path: Path) -> None:
        """v1.6：provider="mock" 的报错必须指向契约（可诊断性），而非
        泛泛的"非法枚举值"。"""
        text = mutate(
            VALID_CONFIG,
            '[models.default]\nprovider = "openai"\nmodel = "scripted-demo"\n'
            'base_url = "http://test.invalid/v1"\napi_key_env = "QAP_TEST_KEY"',
            '[models.default]\nprovider = "mock"\nmodel = "scripted-demo"',
        )
        with pytest.raises(ConfigError) as excinfo:
            load_config(write_config(tmp_path, text))
        message = str(excinfo.value)
        assert "mock" in message and "v1.6" in message
        assert "openai" in message and "anthropic" in message  # 指向可用真实渠道

    def test_mock_provider_rejected_at_model_level(self) -> None:
        """ModelConfig 构造层同样拒绝 provider="mock"（admin PUT 复用该校验）。"""
        from qap.core.config import ModelConfig

        with pytest.raises(Exception, match="v1.6"):
            ModelConfig.model_validate(
                {"provider": "mock", "model": "scripted-demo"}
            )

    def test_empty_models_rejected(self, tmp_path: Path) -> None:
        """models 段被整体删除 → 至少一个模型的约束失败。"""
        text = VALID_CONFIG.replace(
            '[models.default]\nprovider = "openai"\nmodel = "scripted-demo"\n'
            'base_url = "http://test.invalid/v1"\napi_key_env = "QAP_TEST_KEY"\n', ""
        ).replace(
            '[models.claude]\nprovider = "anthropic"\nmodel = "claude-sonnet-4-5"\n'
            "base_url = \"https://api.anthropic.com\"\n"
            'api_key_env = "ANTHROPIC_API_KEY"\ntimeout_seconds = 120\n',
            "",
        )
        with pytest.raises(ConfigError):
            load_config(write_config(tmp_path, text))

    def test_bad_toml_syntax(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError, match="invalid TOML"):
            load_config(write_config(tmp_path, "[server\nbroken ="))

    def test_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError, match="not found"):
            load_config(tmp_path / "nope.toml")

    def test_qap_config_missing_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """显式 QAP_CONFIG 指向不存在文件时不回退探测，直接失败。"""
        monkeypatch.setenv("QAP_CONFIG", str(tmp_path / "nope.toml"))
        with pytest.raises(ConfigError):
            load_config()
