"""外部插件加载器：plugin.json 清单 + importlib 入口加载（契约 §8 v1.1）。

清单（对齐 agent-plugins.org schema 1.0.0 基础字段）：

.. code-block:: json

    { "name": "greeter", "version": "1.0.0", "description": "…",
      "qap": {"entry": "<module>:<factory>"} }

- 扩展键 ``qap.entry``：``模块路径:工厂函数名``；工厂签名
  ``() -> AgentPlugin``，任何异常 → 该插件注册为 broken（带原因），
  **不拖垮平台**。
- 模块解析：优先按文件定位（``plugins_dir/<module>.py`` 或包目录
  ``plugins_dir/<module>/__init__.py``，点号视为路径分隔），避免污染
  ``sys.path`` 与模块名冲突；文件定位失败才回退 ``importlib.import_module``
  （兼容已注入 sys.path 的部署）。
- 加载唯一化为 ``qap_plugin_<目录名>_<模块名>``，防止同名模块互相顶替。

所有可预期失败以 :class:`qap.core.errors.ValidationFailed` 抛出（API 层
映射 422，消息带原因），绝不抛原始异常到平台层。
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from qap.core.errors import ValidationFailed

#: 插件必需属性（AgentPlugin 协议的最小静态检查清单）
_REQUIRED_PLUGIN_ATTRS = ("id", "name", "description", "model_ref", "system_prompt")


@dataclass(frozen=True)
class PluginManifest:
    """plugin.json 的平台相关视图（基础字段 + qap.entry）。"""

    name: str
    version: str
    description: str
    #: ``module:factory`` 入口（已拆分校验）
    entry: str


def read_manifest(plugin_dir: Path) -> PluginManifest:
    """读取并校验插件清单。

    :raises ValidationFailed: 目录缺 plugin.json / JSON 畸形 /
        缺 name / 缺 ``qap.entry`` / entry 形状非法。
    """
    manifest_path = plugin_dir / "plugin.json"
    if not plugin_dir.is_dir() or not manifest_path.is_file():
        raise ValidationFailed(f"plugin manifest not found: {manifest_path}")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationFailed(f"unreadable plugin.json in {plugin_dir}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValidationFailed(f"plugin.json must be a JSON object: {manifest_path}")
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValidationFailed(f"plugin.json missing required field 'name': {manifest_path}")
    qap = data.get("qap")
    if not isinstance(qap, dict) or not str(qap.get("entry") or "").strip():
        raise ValidationFailed(
            f"plugin.json missing extension key 'qap.entry' (\"module:factory\"): {manifest_path}"
        )
    entry = str(qap["entry"]).strip()
    module, sep, factory = entry.partition(":")
    if not sep or not module or not factory:
        raise ValidationFailed(
            f"invalid qap.entry {entry!r}; expected '<module>:<factory>'"
        )
    return PluginManifest(
        name=name,
        version=str(data.get("version") or "0.0.0"),
        description=str(data.get("description") or ""),
        entry=entry,
    )


def _module_file(plugin_dir: Path, module: str) -> tuple[Path, list[Path] | None]:
    """模块名 → (入口文件, 包搜索路径或 None)；无法定位 → ValidationFailed。"""
    target = plugin_dir.joinpath(*module.split("."))
    module_file = target.with_suffix(".py")
    if module_file.is_file():
        return module_file, None
    if (target / "__init__.py").is_file():
        return target / "__init__.py", [target]
    raise ValidationFailed(
        f"entry module {module!r} not found under plugin dir {plugin_dir}"
    )


def _unique_module_name(plugin_dir: Path, module: str) -> str:
    """构造全局唯一模块名（目录名 + 模块路径，仅保留安全字符）。"""
    sanitize = lambda s: re.sub(r"[^0-9A-Za-z_]", "_", s)  # noqa: E731
    return f"qap_plugin_{sanitize(plugin_dir.name)}_{sanitize(module)}"


def load_plugin(plugin_dir: Path, manifest: PluginManifest) -> Any:
    """按清单加载并构造 AgentPlugin 实例。

    :raises ValidationFailed: 模块不存在 / 工厂缺失 / 工厂抛异常 /
        产物缺协议必需属性。所有异常原因进入错误消息（API 422 透出）。
    """
    module_name, _, factory_name = manifest.entry.partition(":")
    entry_file, search_locations = _module_file(plugin_dir, module_name)
    unique = _unique_module_name(plugin_dir, module_name)
    try:
        spec = importlib.util.spec_from_file_location(
            unique, entry_file, submodule_search_locations=search_locations
        )
        if spec is None or spec.loader is None:  # pragma: no cover - 路径已存在性检查
            raise ValidationFailed(f"cannot create import spec for {entry_file}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except ValidationFailed:
        raise
    except Exception as exc:  # 插件代码任意异常都不得拖垮平台
        raise ValidationFailed(f"entry module {module_name!r} failed to import: {exc}") from exc
    factory = getattr(module, factory_name, None)
    if not callable(factory):
        raise ValidationFailed(
            f"entry factory {factory_name!r} not found or not callable in module {module_name!r}"
        )
    try:
        plugin = factory()
    except Exception as exc:
        raise ValidationFailed(
            f"plugin factory for {manifest.name!r} raised: {exc}"
        ) from exc
    for attr in _REQUIRED_PLUGIN_ATTRS:
        value = getattr(plugin, attr, None)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ValidationFailed(
                f"plugin {manifest.name!r} instance missing required attribute {attr!r}"
            )
    return plugin


def try_import_module(module: str) -> Any:
    """回退路径：importlib.import_module（供测试/特殊部署注入 sys.path）。"""
    return importlib.import_module(module)


__all__ = ["PluginManifest", "load_plugin", "read_manifest"]
