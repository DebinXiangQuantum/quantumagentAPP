"""容量分配器：把步骤租约到合适的硬件节点（不变量 3 的执行侧）。

规则：
- 只考虑 ``kind`` 匹配且 ``status == online`` 的节点；
- 单节点活动租约数必须 < ``capacity``（不变量：≤ capacity）；
- 多候选时按（负载比 = 活动租约/capacity，配置顺序）选最闲者，
  使 capacity=4 的 CPU 优先承接多租约、capacity=1 的 QPU 天然串行；
- ``LeaseDenied``（重试可解，容量暂满）与"该 kind 无在线节点"（不可解，
  调用方应直接判失败）是两种不同失败，方法签名分开表达。
租约/释放都会发布 ``hardware.updated`` 事件（契约 §7：分配变化时推送）。
"""

from __future__ import annotations

from qap.core.clock import utcnow_iso
from qap.core.errors import SchedulingError
from qap.domain.models import Allocation, HardwareNode, NodeKind
from qap.events.bus import EventBus
from qap.hardware.registry import NodeRegistry


class LeaseDenied(SchedulingError):
    """当前没有可用容量（该 kind 存在在线节点但租约已满）——可稍后重试。"""

    def __init__(self, kind: NodeKind) -> None:
        super().__init__(f"no free capacity for {kind!r} nodes right now")


class Allocator:
    """硬件租约管理器（asyncio 单线程假设，无锁）。"""

    def __init__(self, registry: NodeRegistry, events: EventBus) -> None:
        self._registry = registry
        self._events = events

    # ---------- 查询 ----------

    def _candidates(self, kind: NodeKind) -> list[HardwareNode]:
        """该 kind 的**在线**节点，按负载比升序（同负载按配置顺序稳定排序）。"""
        nodes = [
            node
            for node_id in self._registry.all_ids()
            if (node := self._registry.get(node_id)).kind == kind and node.status == "online"
        ]
        indexed = list(enumerate(nodes))  # 保留配置顺序作稳定次序
        indexed.sort(key=lambda pair: (len(pair[1].allocations) / pair[1].capacity, pair[0]))
        return [node for _, node in indexed]

    def has_online_node(self, kind: NodeKind) -> bool:
        """是否存在该 kind 的在线节点（与容量无关）。

        返回 False 意味着等待无意义（硬件下线/缺失），调用方应失败步骤。
        """
        return any(
            self._registry.get(node_id).kind == kind
            and self._registry.get(node_id).status == "online"
            for node_id in self._registry.all_ids()
        )

    def free_capacity(self, kind: NodeKind) -> int:
        """该 kind 在线节点剩余租约总数（调度器判断能否立刻开步）。"""
        return sum(
            node.capacity - len(node.allocations)
            for node in self._candidates(kind)
        )

    # ---------- 租约 ----------

    def try_lease(
        self,
        kind: NodeKind,
        *,
        task_id: str,
        step_id: str,
        agent_id: str | None = None,
    ) -> Allocation | None:
        """尝试获取一份租约；容量暂满返回 None（不抛错，便于调度器轮询）。

        :param agent_id: 记入 Allocation，支撑"哪个 Agent 在用哪块 GPU"
            （§10 演示第 4 条的可观察性）。
        """
        for node in self._candidates(kind):
            if len(node.allocations) < node.capacity:
                allocation = Allocation(
                    task_id=task_id,
                    step_id=step_id,
                    agent_id=agent_id,
                    leased_at=utcnow_iso(),
                )
                node.allocations.append(allocation)
                self._publish_update()
                return allocation
        return None

    def lease(self, kind: NodeKind, **kwargs) -> Allocation:
        """同 :meth:`try_lease`，但容量暂满抛 :class:`LeaseDenied`。"""
        allocation = self.try_lease(kind, **kwargs)
        if allocation is None:
            if not self.has_online_node(kind):
                raise SchedulingError(
                    f"no online {kind!r} node available (node(s) offline or unregistered)"
                )
            raise LeaseDenied(kind)
        return allocation

    def release(self, step_id: str) -> None:
        """按 step id 释放租约（幂等；一个 step 至多持有一份租约）。"""
        for node_id in self._registry.all_ids():
            node = self._registry.get(node_id)
            before = len(node.allocations)
            node.allocations = [a for a in node.allocations if a.step_id != step_id]
            if len(node.allocations) != before:
                self._publish_update()

    def release_task(self, task_id: str) -> None:
        """任务终态时兜底清空其全部租约（幂等；防泄漏）。"""
        for node_id in self._registry.all_ids():
            node = self._registry.get(node_id)
            before = len(node.allocations)
            node.allocations = [a for a in node.allocations if a.task_id != task_id]
            if len(node.allocations) != before:
                self._publish_update()

    # ---------- 内部 ----------

    def _publish_update(self) -> None:
        """分配变化 → hardware.updated（全量节点，契约 §7）。"""
        self._events.publish(
            "hardware.updated", {"nodes": [n.model_dump() for n in self._registry.snapshot()]}
        )
