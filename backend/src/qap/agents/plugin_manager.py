"""插件管理器：install / uninstall / 启停 / 列表（契约 §8 v1.1 管理端点）。

职责边界：
- 文件操作：安装 = 复制来源目录到 ``plugins_dir``；卸载 = 删除安装目录；
- 状态持久化：启停写 ``config.local.toml`` 的 ``[agents.plugin_state]``
  （经 :class:`LocalConfigStore`）；卸载时清理状态；
- 运行时生效：经 :class:`PluginRegistry` 注册/摘除（orchestrator 专家
  清单随之自动刷新）。

错误语义（API 层映射）：来源缺清单/入口无法导入 → ValidationFailed(422
带原因)；插件 id 或目录重名 / 卸载内置 → ConflictError(409)；未知插件
→ NotFoundError(404)。
"""

from __future__ import annotations

import shutil
from pathlib import Path

from qap.agents.plugin_loader import load_plugin, read_manifest
from qap.agents.plugins import PluginRegistry
from qap.core.errors import ConflictError, NotFoundError, ValidationFailed
from qap.core.local_store import LocalConfigStore


class PluginManager:
    """安装生命周期的编排器（无并发锁——单进程假设）。"""

    def __init__(
        self,
        registry: PluginRegistry,
        plugins_dir: Path | None,
        store: LocalConfigStore | None,
    ) -> None:
        self._registry = registry
        self._plugins_dir = plugins_dir
        self._store = store

    # ---------- 安装 ----------

    def install(self, source_path: str) -> dict:
        """安装本地来源目录：校验 → 复制到 plugins_dir → 注册。

        :returns: 安装后的管理记录（admin_view 同构）。
        """
        source = Path(source_path).expanduser()
        if not source.is_dir():
            raise ValidationFailed(f"source_path is not a directory: {source}")
        manifest = read_manifest(source)  # 缺 plugin.json / qap.entry → 422
        plugin = load_plugin(source, manifest)  # 入口无法导入 → 422 带原因
        if self._plugins_dir is None:  # 组装缺位防御（测试直建 Registry 时）
            raise ConflictError("plugins_dir is not configured on this deployment")
        if self._registry.knows(plugin.id):
            raise ConflictError(
                f"plugin id {plugin.id!r} already registered "
                f"(builtin or installed)"
            )
        target = self._plugins_dir / source.name
        if target.exists():
            raise ConflictError(f"install directory already exists: {target}")
        self._plugins_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)  # 运行时安装内容只落 plugins_dir（gitignored）
        self._registry.attach_external(plugin.id, target)
        self._registry.register(plugin)
        record = next(
            (r for r in self._registry.admin_view() if r["id"] == plugin.id), None
        )
        assert record is not None  # register 成功后必在视图内（编程不变量）
        return record

    # ---------- 卸载 ----------

    def uninstall(self, plugin_id: str) -> None:
        """卸载已安装插件：删目录 + 清持久化状态 + 注销运行时。"""
        if self._registry.is_builtin(plugin_id):
            raise ConflictError(f"builtin plugin {plugin_id!r} cannot be uninstalled")
        install_dir = self._registry.external_dir(plugin_id)
        if install_dir is None:
            raise NotFoundError("plugin", plugin_id)
        shutil.rmtree(install_dir, ignore_errors=True)
        if self._store is not None:
            self._store.clear_plugin_state(plugin_id)
        self._registry.unregister(plugin_id)

    # ---------- 启停 ----------

    def set_enabled(self, plugin_id: str, enabled: bool) -> dict:
        """启停并持久化到 config.local.toml（builtin 同样可启停）。

        顺序：先改运行时（未知/broken → NotFoundError 404），后落盘。
        """
        self._registry.set_enabled(plugin_id, enabled)
        if self._store is not None:
            self._store.set_plugin_enabled(plugin_id, enabled)
        record = next(
            (r for r in self._registry.admin_view() if r["id"] == plugin_id), None
        )
        assert record is not None
        return record

    # ---------- 查询 ----------

    def list_plugins(self) -> list[dict]:
        """管理列表（builtin + installed + enabled + broken 原因）。"""
        return self._registry.admin_view()


__all__ = ["PluginManager"]
