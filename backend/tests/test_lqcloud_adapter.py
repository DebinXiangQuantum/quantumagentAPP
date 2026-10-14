"""V1 logicalcloud 适配层测试（契约 §3 v1.4 / §9 v1.4）。

四类场景：
- 不变量：circuit JSON→QuantumCircuit 门映射（H/X/Y/Z/RX/RY/RZ(theta)/CX/CZ/
  MEASURE）与序列化产物形状；测量前**必有 barrier**（平台实测硬约束）；
  poll 载荷形状（status + queue_position）。
- 非法输入拒绝：未知门 → ValueError；缺 targets/畸形操作 → ValueError；
  提交未知 backend → 服务端异常透传（BackendNotFoundError）。
- 负样本：提交即抛 CircuitError（服务端拒收）→ 适配层不吞错；
  云端拉取失败 → LqCloudError 原样上抛（V2 组装层转 fail-fast）。
- 可观察行为：FakeProvider 全链 submit → queued(#2) → running → completed
  counts；提交参数（backend 名/shots/readout_correction）被记录。
"""

from __future__ import annotations

import pytest
from lqcloud.exceptions import CircuitError

from qap.hardware.lqcloud_adapter import (
    LqCloudAdapter,
    circuit_to_lqcloud,
    serialize_instructions,
)
from tests.fake_cloud import CIRCUIT_ERROR, FakeCloudProvider


def bell_circuit() -> dict:
    """契约 §6 示例 Bell 线路（H + CNOT + MEASURE）。"""
    return {
        "qubits": 2,
        "operations": [
            {"id": "op-0", "gate": "H", "targets": [0]},
            {"id": "op-1", "gate": "CNOT", "controls": [0], "targets": [1]},
            {"id": "op-2", "gate": "MEASURE", "targets": [0, 1]},
        ],
    }


class TestCircuitConverter:
    def test_bell_circuit_maps_gates_and_auto_inserts_barrier(self) -> None:
        """H/CNOT/MEASURE 正确映射；首个 MEASURE 前自动插入 barrier。"""
        qc = circuit_to_lqcloud(bell_circuit())
        instructions = serialize_instructions(qc)
        names = [i["name"] for i in instructions]
        assert "h" in names and "measure" in names
        # barrier 必须出现在第一条 measure 之前（平台硬约束）
        first_measure = names.index("measure")
        barrier_positions = [i for i, n in enumerate(names) if n == "barrier"]
        assert barrier_positions, "serialized circuit must contain a barrier"
        assert all(p < first_measure for p in barrier_positions)

    def test_supported_gate_zoo_round_trips(self) -> None:
        """X/Y/Z/RX/RY/RZ(theta)/CX/CZ 全门库可转换。"""
        circuit = {
            "qubits": 3,
            "operations": [
                {"id": "op-0", "gate": "X", "targets": [0]},
                {"id": "op-1", "gate": "Y", "targets": [1]},
                {"id": "op-2", "gate": "Z", "targets": [2]},
                {"id": "op-3", "gate": "RX", "targets": [0], "theta": 0.5},
                {"id": "op-4", "gate": "RY", "targets": [1], "theta": -1.25},
                {"id": "op-5", "gate": "RZ", "targets": [2], "theta": 3.14159},
                {"id": "op-6", "gate": "CX", "controls": [0], "targets": [1]},
                {"id": "op-7", "gate": "CZ", "controls": [1], "targets": [2]},
                {"id": "op-8", "gate": "MEASURE", "targets": [0, 1, 2]},
            ],
        }
        qc = circuit_to_lqcloud(circuit)
        names = [i["name"] for i in serialize_instructions(qc)]
        # rx/ry 数值角分解为原生 su2 指令；rz/cx/cz 保留原名
        assert "rz" in names and "cz" in names and "measure" in names
        assert "barrier" in names

    def test_unknown_gate_rejected(self) -> None:
        """未知门 → ValueError（诚实拒绝，不静默跳过）。"""
        circuit = {
            "qubits": 1,
            "operations": [
                {"id": "op-0", "gate": "TOFFOLI", "targets": [0]},
                {"id": "op-1", "gate": "MEASURE", "targets": [0]},
            ],
        }
        with pytest.raises(ValueError, match="TOFFOLI"):
            circuit_to_lqcloud(circuit)

    def test_malformed_operation_rejected(self) -> None:
        """缺 targets 的操作 → ValueError（畸形拒绝）。"""
        with pytest.raises(ValueError):
            circuit_to_lqcloud(
                {"qubits": 1, "operations": [{"id": "op-0", "gate": "H"}]}
            )

    def test_empty_operations_rejected(self) -> None:
        """空操作列表 → ValueError（无可执行的线路）。"""
        with pytest.raises(ValueError):
            circuit_to_lqcloud({"qubits": 2, "operations": []})


class TestAdapterListBackends:
    def test_list_backends_normalizes_cloud_records(self) -> None:
        """get_backends() → 规范 dict（name/chip_architecture/status/qubits/
        topology.qubit_coordinates 五台真机样例：4 active + 1 offline）。"""
        adapter = LqCloudAdapter(FakeCloudProvider())
        backends = adapter.list_backends()
        assert len(backends) == 5
        by_name = {b["name"]: b for b in backends}
        assert by_name["MQ02"]["chip_architecture"] == "AGate 100"  # 实测值
        assert by_name["QZ02"]["status"] == "offline"
        assert sum(1 for b in backends if b["status"] == "active") == 4
        # 实测形状：坐标 dict + 显式 rows/cols + coupling_map（冒烟修正）
        assert by_name["MQ02"]["topology"]["qubit_coordinates"]["0"] == [0, 0]
        assert by_name["MQ02"]["topology"]["rows"] == 2
        assert by_name["MQ02"]["topology"]["coupling_map"][0] == [0, 1]

    def test_list_backends_propagates_fetch_failure(self) -> None:
        """云端不可达 → 异常上抛（V2 组装层转启动 fail-fast）。"""
        from lqcloud.exceptions import LQCloudError

        adapter = LqCloudAdapter(FakeCloudProvider(fetch_error=LQCloudError("unreachable")))
        with pytest.raises(LQCloudError, match="unreachable"):
            adapter.list_backends()


class TestAdapterSubmitPollResult:
    def test_full_chain_submit_queue_run_complete(self) -> None:
        """FakeProvider 全链：submit → queued(#2) → running → completed counts。"""
        provider = FakeCloudProvider(
            poll_script=[("queued", 2), ("queued", 1), ("running", None), ("completed", None)],
            counts={"00": 200, "11": 56},
        )
        adapter = LqCloudAdapter(provider)
        job = adapter.submit(bell_circuit(), shots=256, backend_name="MQ02")
        assert job.job_id.startswith("task_")
        # 轮询脚本逐项推进：位置 2 → 1 → None
        assert adapter.poll(job) == {"status": "queued", "queue_position": 2}
        assert adapter.poll(job) == {"status": "queued", "queue_position": 1}
        assert adapter.poll(job) == {"status": "running", "queue_position": None}
        assert adapter.poll(job) == {"status": "completed", "queue_position": None}
        assert adapter.result_counts(job) == {"00": 200, "11": 56}

    def test_submit_records_backend_shots_and_barrier(self) -> None:
        """提交参数落账：backend 名/shots/readout_correction；序列化产物含
        barrier（转换器责任，FakeProvider 用真实 serialize_circuit 复核）。"""
        provider = FakeCloudProvider()
        adapter = LqCloudAdapter(provider)
        adapter.submit(bell_circuit(), shots=512, backend_name="AGate-100")
        assert len(provider.submissions) == 1
        record = provider.submissions[0]
        assert record["backend_name"] == "AGate-100"
        assert record["shots"] == 512
        assert record["readout_correction"] is True
        assert any(i["name"] == "barrier" for i in record["instructions"])

    def test_submit_propagates_circuit_error(self) -> None:
        """服务端拒收（CircuitError，如缺 barrier）→ 原样上抛为 step.error 源。"""
        adapter = LqCloudAdapter(FakeCloudProvider(fail_with=CIRCUIT_ERROR))
        with pytest.raises(CircuitError):
            adapter.submit(bell_circuit(), shots=64, backend_name="MQ02")

    def test_submit_unknown_backend_rejected(self) -> None:
        """未知 backend 名 → BackendNotFoundError（对齐真实 SDK verify）。"""
        from lqcloud.exceptions import BackendNotFoundError

        adapter = LqCloudAdapter(FakeCloudProvider())
        with pytest.raises(BackendNotFoundError):
            adapter.submit(bell_circuit(), shots=64, backend_name="no-such-qpu")

    def test_poll_failed_job_reports_server_error_path(self) -> None:
        """终态 failed：poll 报 failed；result_counts 抛服务端错误。"""
        from lqcloud.exceptions import JobError

        provider = FakeCloudProvider(
            poll_script=[("queued", 1), ("failed", None)],
            terminal_error="qubit 3 readout timeout",
        )
        adapter = LqCloudAdapter(provider)
        job = adapter.submit(bell_circuit(), shots=64, backend_name="MQ02")
        assert adapter.poll(job)["status"] == "queued"
        assert adapter.poll(job)["status"] == "failed"
        with pytest.raises(JobError, match="readout timeout"):
            adapter.result_counts(job)
