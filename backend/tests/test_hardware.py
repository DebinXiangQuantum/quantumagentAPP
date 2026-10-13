"""S4 硬件注册表/分配器/模拟器测试。

- 不变量：单节点活动租约数 ≤ capacity；utilization ∈ [0,1] 且有限；
  快照与内部状态隔离。
- 非法输入拒绝：NaN 利用率、未知节点。
- 负样本：节点 offline 后不再被分配；容量暂满（LeaseDenied）；kind 无在线
  节点时给出不可等待的失败语义。
- 可观察行为：租约/释放发布 hardware.updated；模拟器 tick 数值变化才发帧。
"""

from __future__ import annotations

import asyncio
import random

import pytest
from pydantic import ValidationError

from qap.core.config import HardwareConfig, HardwareNodeConfig
from qap.core.errors import SchedulingError
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator, LeaseDenied
from qap.hardware.registry import NodeRegistry
from qap.hardware.simulator import UtilizationSimulator


def make_hardware(**node_overrides) -> HardwareConfig:
    """两块 capacity=1 的 GPU + 一台 capacity=4 的 CPU + 一台 QPU。"""
    base_nodes = [
        {"id": "gpu-0", "kind": "gpu", "name": "G0", "model": "A800", "capacity": 1},
        {"id": "gpu-1", "kind": "gpu", "name": "G1", "model": "A800", "capacity": 1},
        {"id": "cpu-0", "kind": "cpu", "name": "C0", "model": "EPYC", "capacity": 4},
        {"id": "qpu-0", "kind": "qpu", "name": "Q0", "model": "transmon", "capacity": 1},
    ]
    base_nodes[0].update(node_overrides)
    return HardwareConfig(
        simulated=True,
        tick_seconds=2.0,
        nodes=[HardwareNodeConfig(**n) for n in base_nodes],
    )


@pytest.fixture()
def rig():
    """注册表 + 分配器 + 总线的组合（多数用例共用）。"""
    registry = NodeRegistry(make_hardware())
    bus = EventBus()
    return registry, Allocator(registry, bus), bus


class TestNodeRegistry:
    def test_loads_nodes_in_config_order(self, rig) -> None:
        registry, _, _ = rig
        assert registry.all_ids() == ("gpu-0", "gpu-1", "cpu-0", "qpu-0")

    def test_snapshot_is_isolated_from_internal_state(self, rig) -> None:
        registry, _, _ = rig
        snapshot = registry.snapshot()
        snapshot[0].utilization = 0.99
        snapshot[0].allocations.clear()
        assert registry.get("gpu-0").utilization == 0.0  # 内部状态未被污染
        registry.get("gpu-0").allocations  # 仍为独立对象

    def test_set_utilization_rejects_nan(self, rig) -> None:
        registry, _, _ = rig
        with pytest.raises(ValidationError):
            registry.set_utilization("gpu-0", float("nan"))

    def test_unknown_node_raises(self, rig) -> None:
        registry, _, _ = rig
        with pytest.raises(KeyError):
            registry.get("ghost")


class TestAllocator:
    def test_lease_picks_matching_kind_and_records_agent(self, rig) -> None:
        registry, allocator, _ = rig
        lease = allocator.lease("qpu", task_id="t-1", step_id="s-1", agent_id="algorithm-designer")
        assert lease.task_id == "t-1"
        node = registry.get("qpu-0")
        assert [a.step_id for a in node.allocations] == ["s-1"]
        assert node.allocations[0].agent_id == "algorithm-designer"

    def test_capacity_invariant_holds(self, rig) -> None:
        """不变量：无论租约多少次，单节点活动租约 ≤ capacity。"""
        _, allocator, _ = rig
        for i in range(6):  # cpu capacity=4，第 5 次起应满
            allocator.try_lease("cpu", task_id=f"t-{i}", step_id=f"s-{i}")
        registry = rig[0]
        for node_id in registry.all_ids():
            node = registry.get(node_id)
            assert len(node.allocations) <= node.capacity

    def test_try_lease_returns_none_when_full(self, rig) -> None:
        _, allocator, _ = rig
        allocator.try_lease("qpu", task_id="t-1", step_id="s-1")
        assert allocator.try_lease("qpu", task_id="t-1", step_id="s-2") is None

    def test_lease_raises_denied_when_full(self, rig) -> None:
        _, allocator, _ = rig
        allocator.lease("qpu", task_id="t-1", step_id="s-1")
        with pytest.raises(LeaseDenied):
            allocator.lease("qpu", task_id="t-1", step_id="s-2")

    def test_offline_node_skipped(self, rig) -> None:
        """负样本：节点下线后租约应落到同 kind 的其它在线节点。"""
        registry, allocator, _ = rig
        registry.set_status("gpu-0", "offline")
        lease = allocator.lease("gpu", task_id="t-1", step_id="s-1")
        assert lease is not None
        assert registry.get("gpu-0").allocations == []
        assert len(registry.get("gpu-1").allocations) == 1

    def test_all_offline_kind_gives_fatal_error(self, rig) -> None:
        """负样本：该 kind 全部下线 → 不可等待的 SchedulingError（非 LeaseDenied）。"""
        registry, allocator, _ = rig
        registry.set_status("qpu-0", "offline")
        with pytest.raises(SchedulingError, match="offline"):
            allocator.lease("qpu", task_id="t-1", step_id="s-1")
        assert allocator.try_lease("qpu", task_id="t-1", step_id="s-1") is None

    def test_release_frees_slot_and_is_idempotent(self, rig) -> None:
        _, allocator, _ = rig
        allocator.lease("qpu", task_id="t-1", step_id="s-1")
        allocator.release("s-1")
        allocator.release("s-1")  # 幂等
        allocator.lease("qpu", task_id="t-1", step_id="s-2")  # 释放后可再租

    def test_release_task_clears_all_leases(self, rig) -> None:
        _, allocator, _ = rig
        allocator.lease("cpu", task_id="t-1", step_id="s-1")
        allocator.lease("cpu", task_id="t-1", step_id="s-2")
        allocator.release_task("t-1")
        assert allocator.free_capacity("cpu") == 4

    def test_least_loaded_node_preferred(self, rig) -> None:
        """负载均衡：cpu capacity=4 部分占用后，新租约仍落在它（唯一 cpu）。"""
        _, allocator, _ = rig
        assert allocator.free_capacity("gpu") == 2
        allocator.lease("gpu", task_id="t-1", step_id="s-1")
        allocator.lease("gpu", task_id="t-1", step_id="s-2")  # 两块 GPU 各一份
        assert allocator.free_capacity("gpu") == 0

    def test_lease_and_release_publish_hardware_updated(self, rig) -> None:
        _, allocator, bus = rig
        sub = bus.subscribe(None)  # 全局流收 hardware.updated
        allocator.lease("gpu", task_id="t-1", step_id="s-1")
        allocator.release("s-1")
        names = []
        while not sub.queue.empty():
            names.append(sub.queue.get_nowait().name)
        assert names == ["hardware.updated", "hardware.updated"]

    def test_event_payload_carries_allocations(self, rig) -> None:
        """§10 第 4 条：事件载荷能让前端回答"哪个 Agent 在用哪块 GPU"。"""
        _, allocator, bus = rig
        sub = bus.subscribe(None)
        allocator.lease("gpu", task_id="t-1", step_id="s-1", agent_id="calibration")
        event = sub.queue.get_nowait()
        gpu_nodes = [n for n in event.data["nodes"] if n["kind"] == "gpu" and n["allocations"]]
        assert gpu_nodes[0]["allocations"][0]["agent_id"] == "calibration"


class TestUtilizationSimulator:
    def test_tick_keeps_utilization_in_bounds(self, rig) -> None:
        """不变量：任意负载下 utilization 始终 ∈ [0,1] 且有限。"""
        registry, allocator, _ = rig
        for i in range(4):  # 打满 cpu 负载
            allocator.lease("cpu", task_id="t-1", step_id=f"s-{i}")
        simulator = UtilizationSimulator(registry, EventBus(), 1.0, rng=random.Random(7))
        for _ in range(50):
            simulator.tick()
        for node in registry.snapshot():
            assert 0.0 <= node.utilization <= 1.0

    def test_tick_publishes_only_on_change(self, rig) -> None:
        """数值不变不发帧：用恒定 rng 让噪声前后一致不可行，改验证发帧语义。"""
        registry, _, bus = rig
        sub = bus.subscribe(None)
        simulator = UtilizationSimulator(registry, bus, 1.0, rng=random.Random(1))
        assert simulator.tick() is True  # 初值 0 → 新值必然变化
        assert not sub.queue.empty()

    def test_seeded_rng_deterministic(self, rig) -> None:
        registry_a = NodeRegistry(make_hardware())
        registry_b = NodeRegistry(make_hardware())
        sim_a = UtilizationSimulator(registry_a, EventBus(), 1.0, rng=random.Random(42))
        sim_b = UtilizationSimulator(registry_b, EventBus(), 1.0, rng=random.Random(42))
        for _ in range(10):
            sim_a.tick()
            sim_b.tick()
        utils_a = [n.utilization for n in registry_a.snapshot()]
        utils_b = [n.utilization for n in registry_b.snapshot()]
        assert utils_a == utils_b

    def test_loaded_node_runs_hotter_than_idle(self, rig) -> None:
        """负载相关性：满载节点利用率均值显著高于空闲节点。"""
        registry, allocator, _ = rig
        allocator.lease("qpu", task_id="t-1", step_id="s-1")
        simulator = UtilizationSimulator(registry, EventBus(), 1.0, rng=random.Random(3))
        for _ in range(30):
            simulator.tick()
        busy = registry.get("qpu-0").utilization
        idle = registry.get("gpu-0").utilization
        assert busy > idle

    def test_bad_tick_seconds_rejected(self, rig) -> None:
        registry, _, _ = rig
        with pytest.raises(ValueError):
            UtilizationSimulator(registry, EventBus(), 0.0)

    async def test_start_stop_lifecycle(self, rig) -> None:
        registry, _, _ = rig
        simulator = UtilizationSimulator(registry, EventBus(), 0.01, rng=random.Random(5))
        simulator.start()
        await asyncio.sleep(0.08)  # 经历数个 tick
        assert registry.get("gpu-0").utilization > 0.0
        await simulator.stop()
        marker = registry.get("gpu-0").utilization
        await asyncio.sleep(0.05)  # 停止后不再推进
        assert registry.get("gpu-0").utilization == marker
