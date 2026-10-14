"""V2 硬件注册表 provider 模式测试（契约 §3 v1.4）。

四类场景：
- 不变量：provider 枚举收敛；logicalcloud 节点形状（id=lq-<name>、
  model=chip_architecture、active→online/其余→offline、capacity=1、
  利用率 0 不漂移）；cloud topology（rows/cols=坐标极值+1、couplers 空、
  fidelity 全 null）可通过对外校验函数（cloud-observed 分支）。
- 非法输入拒绝：未知 provider / 空 lqcloud 键 / simulated 模式空节点表。
- 负样本：云端拉取失败 → 启动 fail-fast（ConfigError 带原因）；密钥环境
  变量缺失 → fail-fast。
- 可观察行为：logicalcloud 模式忽略手写 qpu 节点、保留 gpu/cpu；模拟器
  tick 只作用于 simulated 节点；调度器只租约 online 的 lq-* 节点。
"""

from __future__ import annotations

import pytest
from lqcloud.exceptions import LQCloudError
from pydantic import ValidationError

from qap.core.config import ConfigError, HardwareConfig, HardwareNodeConfig
from qap.domain.invariants import validate_node_metrics
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import build_cloud_nodes, build_node_registry
from qap.hardware.simulator import UtilizationSimulator
from tests.fake_cloud import DEFAULT_FAKE_BACKENDS, FakeCloudProvider


def logicalcloud_config(
    *, nodes: list[HardwareNodeConfig] | None = None, **overrides
) -> HardwareConfig:
    """logicalcloud 模式配置：手写 1 台 qpu（应被忽略）+ gpu/cpu 各 1。"""
    base = {
        "provider": "logicalcloud",
        "simulated": True,
        "tick_seconds": 2.0,
        "nodes": nodes
        if nodes is not None
        else [
            HardwareNodeConfig(
                id="qpu-handwritten", kind="qpu", name="手写 QPU",
                model="superconducting-transmon", capacity=1,
                topology={"rows": 2, "cols": 2},
            ),
            HardwareNodeConfig(
                id="gpu-a800-0", kind="gpu", name="A800 #0",
                model="NVIDIA A800 80GB", capacity=1, vram_total_gb=80.0,
            ),
            HardwareNodeConfig(
                id="cpu-node-0", kind="cpu", name="经典 #0",
                model="EPYC", capacity=4, cpu_cores=64, memory_total_gb=256.0,
            ),
        ],
    }
    base.update(overrides)
    return HardwareConfig(**base)


class TestConfigProviderMode:
    def test_unknown_provider_rejected(self) -> None:
        with pytest.raises(ValidationError):
            logicalcloud_config(provider="quantumcloud")

    def test_provider_defaults_to_simulated(self) -> None:
        config = HardwareConfig(
            simulated=True,
            tick_seconds=2.0,
            nodes=[HardwareNodeConfig(id="q-0", kind="cpu", name="C", model="m", capacity=1)],
        )
        assert config.provider == "simulated"
        assert config.lqcloud_base_url == "https://cloud.logicalqubit.com"
        assert config.lqcloud_api_key_env == "LQCLOUD_API_KEY"

    def test_blank_lqcloud_keys_rejected(self) -> None:
        with pytest.raises(ValidationError):
            logicalcloud_config(lqcloud_api_key_env="  ")
        with pytest.raises(ValidationError):
            logicalcloud_config(lqcloud_base_url="")

    def test_simulated_mode_requires_nodes(self) -> None:
        with pytest.raises(ValidationError):
            HardwareConfig(simulated=True, tick_seconds=2.0, nodes=[])

    def test_logicalcloud_mode_allows_empty_nodes(self) -> None:
        config = logicalcloud_config(nodes=[])
        assert config.nodes == []


class TestCloudNodeConstruction:
    def test_registry_ignores_handwritten_qpu_keeps_gpu_cpu(self) -> None:
        """logicalcloud：QPU 实拉（5 台），手写 qpu 忽略，gpu/cpu 保留。"""
        registry = build_node_registry(
            logicalcloud_config(), adapter=_adapter(), rng=_rng()
        )
        ids = registry.all_ids()
        assert "qpu-handwritten" not in ids
        assert "gpu-a800-0" in ids and "cpu-node-0" in ids
        lq_ids = [i for i in ids if i.startswith("lq-")]
        assert len(lq_ids) == 5
        assert ids[:5] == tuple(lq_ids)  # 云拉 QPU 排前

    def test_cloud_node_fields_map_cloud_records(self) -> None:
        registry = build_node_registry(
            logicalcloud_config(), adapter=_adapter(), rng=_rng()
        )
        mq02 = registry.get("lq-MQ02")
        assert mq02.kind == "qpu"
        assert mq02.model == "superconducting-transmon"
        assert mq02.status == "online"
        assert mq02.capacity == 1
        assert mq02.utilization == 0.0
        qz02 = registry.get("lq-QZ02")
        assert qz02.status == "offline"

    def test_cloud_topology_built_from_qubit_coordinates(self) -> None:
        nodes = {n.id: n for n in build_cloud_nodes(DEFAULT_FAKE_BACKENDS)}
        metrics = nodes["lq-QZ01-repetition_code"].metrics
        assert metrics["source"] == "cloud-observed"
        topology = metrics["topology"]
        # 坐标 [[0,0]..[0,11]] → cols=12, rows=1（极值+1）
        assert topology["rows"] == 1 and topology["cols"] == 12
        assert metrics["qubits_count"] == 12 == len(topology["qubits"])
        assert topology["couplers"] == []  # 平台未提供耦合器信息
        qubit = topology["qubits"][0]
        assert qubit["t1_us"] is None and qubit["t2_us"] is None
        assert qubit["readout_fidelity"] is None and qubit["sq_fidelity"] is None

    def test_cloud_metrics_pass_invariants_cloud_branch(self) -> None:
        for node in build_cloud_nodes(DEFAULT_FAKE_BACKENDS):
            validate_node_metrics(node.kind, node.metrics)  # 不抛即通过

    def test_invariants_reject_simulated_shape_with_null_fidelity(self) -> None:
        """simulated 形状（无 source 标注）携带 null 保真度 → 违例。"""
        bad = {
            "qubits_count": 2,
            "topology": {
                "layout": "grid", "rows": 1, "cols": 2,
                "qubits": [
                    {"id": 0, "t1_us": None, "t2_us": None,
                     "readout_fidelity": None, "sq_fidelity": None},
                    {"id": 1, "t1_us": None, "t2_us": None,
                     "readout_fidelity": None, "sq_fidelity": None},
                ],
                "couplers": [],
            },
        }
        with pytest.raises(Exception):
            validate_node_metrics("qpu", bad)

    def test_invariants_reject_cloud_branch_with_fake_couplers(self) -> None:
        """cloud-observed 分支不得伪造耦合器保真度（诚实为空）。"""
        nodes = build_cloud_nodes(DEFAULT_FAKE_BACKENDS)
        metrics = dict(nodes[0].metrics)
        metrics["topology"] = {
            **metrics["topology"],
            "couplers": [{"a": 0, "b": 1, "tq_fidelity": 0.99}],
        }
        with pytest.raises(Exception):
            validate_node_metrics("qpu", metrics)


class TestFailFast:
    def test_fetch_failure_fails_startup_with_reason(self) -> None:
        adapter = _adapter(fetch_error=LQCloudError("connection refused (boom)"))
        with pytest.raises(ConfigError, match="logicalcloud.*boom"):
            build_node_registry(logicalcloud_config(), adapter=adapter, rng=_rng())

    def test_missing_api_key_env_fails_startup(self, monkeypatch) -> None:
        monkeypatch.delenv("LQCLOUD_API_KEY", raising=False)
        with pytest.raises(ConfigError, match="LQCLOUD_API_KEY"):
            build_node_registry(logicalcloud_config(), rng=_rng())


class TestSimulatorAndScheduling:
    def test_simulator_does_not_drift_cloud_nodes(self) -> None:
        """tick 只作用于 simulated 节点：gpu 漂移、lq-* 保持 0/静态。"""
        registry = build_node_registry(
            logicalcloud_config(), adapter=_adapter(), rng=_rng()
        )
        bus = EventBus()
        simulator = UtilizationSimulator(registry, bus, tick_seconds=2.0, rng=_rng())
        cloud_before = {
            i: (registry.get(i).utilization, registry.get(i).metrics)
            for i in registry.all_ids() if i.startswith("lq-")
        }
        gpu_before = registry.get("gpu-a800-0").utilization
        for _ in range(3):
            simulator.tick()
        for node_id, (utilization, metrics) in cloud_before.items():
            assert registry.get(node_id).utilization == utilization == 0.0
            assert registry.get(node_id).metrics == metrics  # 无漂移（无伪造）
        assert registry.get("gpu-a800-0").utilization != gpu_before  # 模拟节点照常

    def test_simulated_mode_registry_unchanged(self) -> None:
        """simulated 模式（缺省 provider）行为与 v3 完全一致。"""
        config = HardwareConfig(
            simulated=True, tick_seconds=2.0,
            nodes=[
                HardwareNodeConfig(id="qpu-0", kind="qpu", name="Q", model="m",
                                   capacity=1, topology={"rows": 2, "cols": 2}),
                HardwareNodeConfig(id="cpu-0", kind="cpu", name="C", model="m",
                                   capacity=4, cpu_cores=8, memory_total_gb=16.0),
            ],
        )
        registry = build_node_registry(config, rng=_rng())
        assert registry.all_ids() == ("qpu-0", "cpu-0")
        assert registry.get("qpu-0").metrics["topology"]["layout"] == "grid"

    def test_scheduler_leases_only_online_cloud_qpus(self) -> None:
        """既有调度语义保持：只租约 online 的 lq-* 节点（QZ02 offline 不可租）。"""
        registry = build_node_registry(
            logicalcloud_config(), adapter=_adapter(), rng=_rng()
        )
        allocator = Allocator(registry, EventBus())
        leased_ids = set()
        for i in range(4):  # 4 台 online，第 5 次应失败（QZ02 offline）
            lease = allocator.try_lease("qpu", task_id=f"t-{i}", step_id=f"s-{i}")
            assert lease is not None
            leased_ids.add(allocator.node_id_of(f"s-{i}"))
        assert len(leased_ids) == 4
        assert "lq-QZ02" not in leased_ids
        assert allocator.try_lease("qpu", task_id="t-9", step_id="s-9") is None


# ---------- 助手 ----------

def _adapter(**kwargs) -> object:
    """FakeCloudProvider 的适配器（注入构造，零网络）。"""
    from qap.hardware.lqcloud_adapter import LqCloudAdapter

    return LqCloudAdapter(FakeCloudProvider(**kwargs))


def _rng():
    import random

    return random.Random(1234)
