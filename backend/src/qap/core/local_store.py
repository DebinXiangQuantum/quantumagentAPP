"""config.local.toml 的读-改-写存储（契约 §3 v1.1 / §5 / §8）。

定位：本地覆盖层是管理平台（admin models / plugins）的**唯一持久化出口**
——内联 api_key 与插件启停状态只落在这个 gitignored 文件里，仓库永不
出现密钥。

实现说明（工程选择）：
- 无第三方 TOML 写库依赖，序列化器只支持本平台可控的子集：
  str/int/float/bool、标量数组、任意深度 dict（写成嵌套表头）；
  深层值域由调用方（ModelConfig/PluginStateConfig）先行校验。
- 读-改-写会**重写整份文件**：未知小节（如手写的 [server] 覆盖）按值
  保留，但注释与键序会丢失——原型接受的权衡，见 change.log。
- 表头键、含点号/特殊字符的键用 TOML 基本字符串加引号（json.dumps 的
  转义规则与 TOML 基本字符串兼容）。
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any

from qap.core.config import ConfigError, LOCAL_CONFIG_FILENAME


def _format_value(value: Any) -> str:
    """标量/标量数组 → TOML 字面量（不支持类型 → TypeError，调用方前置校验）。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        # json.dumps 的转义（\" \\ \uXXXX）在 TOML 基本字符串中全部合法
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        if not all(isinstance(item, (str, int, float, bool)) for item in value):
            raise TypeError(f"unsupported array element types: {value!r}")
        return "[" + ", ".join(_format_value(item) for item in value) + "]"
    raise TypeError(f"unsupported TOML value type: {type(value).__name__}")


def _format_key(key: str) -> str:
    """键 → 裸键（安全字符集内）或加引号的基本字符串键。"""
    if key and all(ch.isalnum() or ch in "-_" for ch in key):
        return key
    return json.dumps(key, ensure_ascii=False)


def dump_toml(data: dict[str, Any]) -> str:
    """dict → TOML 文本（顶层标量在前，随后逐表展开）。

    只有携带叶子键的表才写表头（纯容器表隐式创建），避免
    ``[a]`` 与 ``[a.b]`` 双重定义的 TOML 语法错误。
    """
    lines: list[str] = _dump_table(data, prefix=[])
    return "\n".join(lines).rstrip("\n") + "\n"


def _dump_table(table: dict[str, Any], prefix: list[str]) -> list[str]:
    """递归展开一张表：叶子键先写，子表按字典序递归（输出确定性）。"""
    scalars = {k: v for k, v in table.items() if not isinstance(v, dict)}
    children = {k: v for k, v in table.items() if isinstance(v, dict)}
    lines: list[str] = []
    if prefix and scalars:
        header = ".".join(_format_key(part) for part in prefix)
        lines.append(f"[{header}]")
    for key in scalars:
        lines.append(f"{_format_key(key)} = {_format_value(scalars[key])}")
    for key in sorted(children):
        child_prefix = [*prefix, key]
        child = children[key]
        if child:  # 空表无内容可写（保留语义：调用方不应写入空表）
            lines.append("")
            lines.extend(_dump_table(child, child_prefix))
    return lines


class LocalConfigStore:
    """一个 config.local.toml 文件的读-改-写门面（无并发锁——单进程假设）。"""

    def __init__(self, path: Path) -> None:
        """目标文件路径（通常为基底配置同目录的 config.local.toml）。"""
        self._path = Path(path)

    @property
    def path(self) -> Path:
        """存储文件路径（测试与管理 API 展示用）。"""
        return self._path

    def load(self) -> dict[str, Any]:
        """读取整份文件；文件不存在返回空 dict。

        :raises ConfigError: TOML 语法错误（fail-fast，与启动加载一致）。
        """
        if not self._path.is_file():
            return {}
        try:
            with open(self._path, "rb") as fh:
                return tomllib.load(fh)
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"invalid TOML in {self._path}: {exc}") from exc

    def save(self, data: dict[str, Any]) -> None:
        """整份写回（自动创建父目录；文件名固定，不存在则新建）。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(dump_toml(data), encoding="utf-8")

    # ---------- 渠道池（§5 admin models） ----------

    def upsert_model(self, ref: str, entry: dict[str, Any]) -> None:
        """写入/整体替换 ``[models.<ref>]`` 条目（entry 已过 ModelConfig 校验）。"""
        if not ref or not isinstance(entry, dict):
            raise ValueError("ref must be non-empty and entry must be a dict")
        data = self.load()
        data.setdefault("models", {})[ref] = dict(entry)
        self.save(data)

    def delete_model(self, ref: str) -> bool:
        """删除 ``[models.<ref>]``；条目不存在返回 False（幂等语义）。"""
        data = self.load()
        models = data.get("models")
        if not isinstance(models, dict) or ref not in models:
            return False
        del models[ref]
        if not models:
            data.pop("models", None)  # 空 [models] 表不保留
        self.save(data)
        return True

    # ---------- 插件启停（§8 plugin_state） ----------

    def set_plugin_enabled(self, plugin_id: str, enabled: bool) -> None:
        """写 ``[agents.plugin_state."<id>"] enabled = <bool>``。"""
        if not plugin_id:
            raise ValueError("plugin_id must be non-empty")
        data = self.load()
        data.setdefault("agents", {}).setdefault("plugin_state", {})[plugin_id] = {
            "enabled": bool(enabled)
        }
        self.save(data)

    def clear_plugin_state(self, plugin_id: str) -> None:
        """移除某插件的持久化状态（卸载时调用；不存在则无操作）。"""
        data = self.load()
        agents = data.get("agents")
        state = agents.get("plugin_state") if isinstance(agents, dict) else None
        if not isinstance(state, dict) or plugin_id not in state:
            return
        del state[plugin_id]
        if not state:  # 空表上卷清理，避免残留空 [agents.plugin_state]
            agents.pop("plugin_state")
            if not agents:
                data.pop("agents", None)
        self.save(data)


__all__ = [
    "LOCAL_CONFIG_FILENAME",
    "LocalConfigStore",
    "dump_toml",
]
