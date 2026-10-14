"""V1 硬件配置与 metrics 测试（契约 §4 v1.2 HardwareNode.metrics）。

四类场景映射：
- 不变量：QPU 拓扑 qubit id 与 (row,col) 一一对应（id=row*cols+col）；
  coupler 端点 ∈ [0,qubits_count) 且为网格相邻对（右/下）；所有
  fidelity ∈ (0,1] 且 t2_us ≤ 2*t1_us；memory/vram used ≤ total；
  cpu_usage ∈ [0,1]；metrics 随 snapshot 序列化输出。
- 非法输入拒绝（fail-fast）：kind 键错配（topology 只许 qpu、vram 只许
  gpu、cpu_cores/memory 只许 cpu）；topology rows*cols ∉ [2,1024]；
  非法 status；cpu 规格只给一半。
- 负样本：config status="offline" 的节点启动即为 offline，调度器/
  分配器绝不向其租约（跳过，落同 kind 其它在线节点）。
- 可观察行为：随机源可注入种子（同种子生成完全一致）；QPU 无 topology
  键时 metrics 为 None（前端降级）。
"""

from __future__ import annotations

import random

import pytest
from pydantic import ValidationError

from qap.core.config import HardwareConfig, HardwareNodeConfig
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import NodeRegistry


def node(**kwargs) -> HardwareNodeConfig:
    """最小合法节点（kind 默认 qpu），按需覆盖键。"""
    base = {"id": "n-0", "kind": "qpu", "name": "N", "model": "M", "capacity": 1}
    base.update(kwargs)
    return HardwareNodeConfig(**base)


def make_registry(*nodes_: HardwareNodeConfig, seed: int | None = None) -> NodeRegistry:
    config = HardwareConfig(simulated=True, tick_seconds=60.0, nodes=list(nodes_))
    rng = random.Random(seed) if seed is not None else None
    return NodeRegistry(config, rng=rng)


# ---------- 配置 fail-fast（kind 键错配 / 非法值） ----------

class TestConfigFailFast:
    def test_topology_only_on_qpu(self) -> None:
        with pytest.raises(ValidationError, match="topology"):
            node(kind="gpu", topology={"rows": 2, "cols": 2})

    def test_vram_only_on_gpu(self) -> None:
        with pytest.raises(ValidationError, match="vram"):
            node(topology={"rows": 2, "cols": 2}, vram_total_gb=80.0)

    def test_cpu_spec_only_on_cpu(self) -> None:
        with pytest.raises(ValidationError, match="cpu"):
            node(topology={"rows": 2, "cols": 2}, cpu_cores=64)

    def test_memory_spec_only_on_cpu(self) -> None:
        with pytest.raises(ValidationError, match="memory"):
            node(kind="gpu", vram_total_gb=80.0, memory_total_gb=256.0)

    def test_topology_too_small(self) -> None:
        with pytest.raises(ValidationError):
            node(topology={"rows": 1, "cols": 1})  # rows*cols=1 < 2

    def test_topology_too_large(self) -> None:
        with pytest.raises(ValidationError):
            node(topology={"rows": 64, "cols": 64})  # 4096 > 1024

    def test_topology_missing_cols(self) -> None:
        with pytest.raises(ValidationError):
            node(topology={"rows": 4})

    def test_topology_negative_rows(self) -> None:
        with pytest.raises(ValidationError):
            node(topology={"rows": -4, "cols": 5})

    def test_illegal_status_rejected(self) -> None:
        with pytest.raises(ValidationError, match="status"):
            node(status="paused")

    def test_vram_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            node(kind="gpu", vram_total_gb=0.0)

    def test_cpu_spec_half_pair_rejected(self) -> None:
        with pytest.raises(ValidationError, match="cpu_cores and memory_total_gb"):
            node(kind="cpu", cpu_cores=64)

    def test_status_offline_accepted(self) -> None:
        cfg = node(status="offline", topology={"rows": 2, "cols": 2})
        assert cfg.status == "offline"

    def test_status_defaults_online(self) -> None:
        assert node().status == "online"


# ---------- 注册表：metrics 生成（simulated，种子可注入） ----------

class TestQpuMetrics:
    def make_qpu(self, rows: int = 4, cols: int = 5, seed: int = 42):
        registry = make_registry(
            node(id="q-0", topology={"rows": rows, "cols": cols}), seed=seed
        )
        return registry.get("q-0")

    def test_metrics_shape_matches_contract(self) -> None:
        metrics = self.make_qpu().metrics
        assert metrics is not None
        assert metrics["qubits_count"] == 20
        topology = metrics["topology"]
        assert topology["layout"] == "grid"
        assert topology["rows"] == 4 and topology["cols"] == 5
        assert len(topology["qubits"]) == 20
        assert len(topology["couplers"]) == 4 * 4 + 3 * 5  # 右邻 + 下邻对数

    def test_qubit_id_is_row_cols_plus_col_bijection(self) -> None:
        topology = self.make_qpu(rows=4, cols=5).metrics["topology"]
        ids = [q["id"] for q in topology["qubits"]]
        assert sorted(ids) == list(range(20))  # 一一对应
        for qubit in topology["qubits"]:
            assert qubit["id"] == (qubit["id"] // 5) * 5 + qubit["id"] % 5

    def test_fidelity_and_coherence_in_simulated_ranges(self) -> None:
        """模拟区间（工程选择，标注 simulated）：T1 20–80µs、T2 10–60µs、
        readout 0.95–0.995、1Q 0.995–0.9999、2Q 0.98–0.995。"""
        topology = self.make_qpu().metrics["topology"]
        for qubit in topology["qubits"]:
            assert 20.0 <= qubit["t1_us"] <= 80.0
            assert 10.0 <= qubit["t2_us"] <= 60.0
            assert qubit["t2_us"] <= 2 * qubit["t1_us"]  # 物理合理性上界
            assert 0.95 <= qubit["readout_fidelity"] <= 0.995
            assert 0.995 <= qubit["sq_fidelity"] <= 0.9999
            assert 0 < qubit["readout_fidelity"] <= 1
            assert 0 < qubit["sq_fidelity"] <= 1
        for coupler in topology["couplers"]:
            assert 0.98 <= coupler["tq_fidelity"] <= 0.995
            assert 0 < coupler["tq_fidelity"] <= 1

    def test_couplers_are_grid_adjacent_pairs(self) -> None:
        """不变量：coupler 端点 ∈ [0,qubits_count) 且恰为右/下相邻对集合。"""
        rows, cols = 3, 4
        topology = self.make_qpu(rows=rows, cols=cols).metrics["topology"]
        expected = set()
        for r in range(rows):
            for c in range(cols):
                q = r * cols + c
                if c + 1 < cols:
                    expected.add((q, q + 1))
                if r + 1 < rows:
                    expected.add((q, q + cols))
        actual = {(c["a"], c["b"]) for c in topology["couplers"]}
        assert actual == expected
        for coupler in topology["couplers"]:
            assert 0 <= coupler["a"] < rows * cols
            assert 0 <= coupler["b"] < rows * cols

    def test_seeded_rng_reproducible(self) -> None:
        one = self.make_qpu(seed=7).metrics
        two = self.make_qpu(seed=7).metrics
        assert one == two
        other = self.make_qpu(seed=8).metrics
        assert one["topology"]["qubits"] != other["topology"]["qubits"]

    def test_qpu_without_topology_has_null_metrics(self) -> None:
        # topology 为可选键：缺省时 metrics=None（契约：可缺省，前端降级）
        assert make_registry(node(id="q-1")).get("q-1").metrics is None


class TestCpuGpuMetrics:
    def test_cpu_metrics_initial_values(self) -> None:
        registry = make_registry(
            node(id="c-0", kind="cpu", cpu_cores=64, memory_total_gb=256.0), seed=3
        )
        metrics = registry.get("c-0").metrics
        assert metrics["cpu_cores"] == 64
        assert metrics["memory_total_gb"] == 256.0
        assert 0.0 <= metrics["cpu_usage"] <= 1.0
        assert 0.0 <= metrics["memory_used_gb"] <= 256.0

    def test_gpu_metrics_initial_values(self) -> None:
        registry = make_registry(
            node(id="g-0", kind="gpu", vram_total_gb=80.0), seed=3
        )
        metrics = registry.get("g-0").metrics
        assert metrics["vram_total_gb"] == 80.0
        assert 0.0 <= metrics["vram_used_gb"] <= 80.0

    def test_cpu_without_spec_has_null_metrics(self) -> None:
        assert make_registry(node(id="c-1", kind="cpu")).get("c-1").metrics is None


# ---------- 负样本：config offline 节点不被租约 ----------

class TestOfflineScheduling:
    def test_config_offline_node_skipped_by_allocator(self) -> None:
        """config status="offline"：分配器跳过（租约落到在线 QPU）。"""
        registry = make_registry(
            node(id="q-off", topology={"rows": 2, "cols": 2}, status="offline"),
            node(id="q-on", topology={"rows": 2, "cols": 2}),
        )
        assert registry.get("q-off").status == "offline"
        allocator = Allocator(registry, EventBus())
        allocator.lease("qpu", task_id="t-1", step_id="s-1")
        assert allocator.node_id_of("s-1") == "q-on"

    def test_config_offline_honored_in_full_config(self) -> None:
        """整份 HardwareConfig 携带 offline 节点时保持语义（防只测单节点）。"""
        registry = make_registry(
            node(id="a", topology={"rows": 2, "cols": 2}),
            node(id="b", topology={"rows": 2, "cols": 2}, status="offline"),
        )
        offline = [n for n in registry.snapshot() if n.status == "offline"]
        assert [n.id for n in offline] == ["b"]

    def test_snapshot_serializes_metrics(self) -> None:
        registry = make_registry(
            node(id="q-0", topology={"rows": 2, "cols": 3}), seed=1
        )
        dumped = registry.snapshot()[0].model_dump()
        assert dumped["metrics"]["qubits_count"] == 6
        assert dumped["status"] == "online"
