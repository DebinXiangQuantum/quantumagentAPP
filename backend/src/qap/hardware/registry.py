"""硬件节点注册表：config.toml 的 ``[[hardware.nodes]]`` 的运行时权威副本。

- 注册表持有**权威** :class:`HardwareNode` 实例（含活动租约、利用率与
  v1.2 metrics）；对外一律通过 :meth:`snapshot` 给出深拷贝，避免调用方
  误改内部状态（分配器/模拟器是仅有的两个内部协作者）。
- 所有变更都过模型校验（utilization 有限且 ∈ [0,1]，容量 ≥ 1），
  非法值立即抛 ``ValidationError``——不变量 3 的第一道防线。
- metrics 初值按 kind 由 ``hardware/metrics.py`` 生成（simulated，
  随机源 ``rng`` 可注入种子 → 可复现）；``status`` 透传配置
  （config ``offline`` 节点自启动即不可调度）。
"""

from __future__ import annotations

import copy
import random

from qap.core.config import HardwareConfig
from qap.domain.models import HardwareNode, NodeStatus
from qap.hardware.metrics import build_initial_metrics


class NodeRegistry:
    """进程内硬件注册表（按配置顺序保序，事件推送的节点顺序以此为准）。"""

    def __init__(
        self, config: HardwareConfig, *, rng: random.Random | None = None
    ) -> None:
        self._nodes: dict[str, HardwareNode] = {}
        source = rng if rng is not None else random.Random()
        for node_config in config.nodes:
            if node_config.id in self._nodes:  # 配置层已查重，防御性保留
                raise ValueError(f"duplicate node id {node_config.id!r}")
            self._nodes[node_config.id] = HardwareNode(
                id=node_config.id,
                kind=node_config.kind,
                name=node_config.name,
                model=node_config.model,
                capacity=node_config.capacity,
                status=node_config.status,
                metrics=build_initial_metrics(node_config, source),
            )
        self._order = tuple(node_config.id for node_config in config.nodes)

    # ---------- 查询 ----------

    def get(self, node_id: str) -> HardwareNode:
        """取内部权威实例（仅分配器/模拟器使用；业务代码请用 snapshot）。"""
        node = self._nodes.get(node_id)
        if node is None:
            raise KeyError(f"unknown hardware node {node_id!r}")
        return node

    def find(self, node_id: str) -> HardwareNode | None:
        """按 id 查找，不存在返回 None（区别于 get 的 KeyError）。"""
        return self._nodes.get(node_id)

    def snapshot(self) -> list[HardwareNode]:
        """全量节点深拷贝（API/事件/工具的统一出口，按配置顺序）。"""
        import copy

        return [copy.deepcopy(self._nodes[node_id]) for node_id in self._order]

    def all_ids(self) -> tuple[str, ...]:
        return self._order

    def __len__(self) -> int:
        return len(self._nodes)

    # ---------- 变更（内部协作者使用） ----------

    def set_status(self, node_id: str, status: NodeStatus) -> None:
        """上线/下线节点（负样本测试与管理入口）。"""
        self.get(node_id).status = status

    def set_utilization(self, node_id: str, value: float) -> None:
        """更新利用率；非法值（NaN/±inf/越界）由模型校验拒绝。"""
        self.get(node_id).utilization = value

    def set_metrics(self, node_id: str, metrics: dict | None) -> None:
        """整体替换该节点的 metrics（模拟器漂移专用；dict 为值拷贝语义）。

        调用方（模拟器）负责保证漂移构造性满足 §4 v1.2 不变量；
        本方法做防御性深拷贝，避免外部字典与内部状态共享引用。
        """
        self.get(node_id).metrics = copy.deepcopy(metrics)
