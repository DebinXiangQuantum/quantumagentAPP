"""S2 Artifact 载荷校验测试（契约 §6 的全部约束分支）。

- 不变量：counts 计数守恒、比特串长度 == qubits。
- 非法输入拒绝：越界 qubit、门数约束、NaN 采样、坏键格式……
"""

from __future__ import annotations

import math

import pytest

from qap.core.errors import ValidationFailed
from qap.domain.artifacts import validate_artifact_payload


def circuit(**overrides) -> dict:
    """合法 Bell 态线路（契约 §6 示例），供各用例做单字段突变。"""
    payload = {
        "qubits": 2,
        "operations": [
            {"id": "op-0", "gate": "H", "targets": [0]},
            {"id": "op-1", "gate": "CNOT", "controls": [0], "targets": [1]},
            {"id": "op-2", "gate": "MEASURE", "targets": [0, 1]},
        ],
    }
    payload.update(overrides)
    return payload


def counts(**overrides) -> dict:
    payload = {"shots": 1024, "qubits": 2, "counts": {"00": 498, "11": 512, "01": 8, "10": 6}}
    payload.update(overrides)
    return payload


def waveform(**overrides) -> dict:
    payload = {
        "sample_rate_ns": 1.0,
        "unit": "mV",
        "channels": [
            {"label": "Q0 I", "samples": [0.0, 0.12, 0.5, 0.12, 0.0]},
            {"label": "Q0 Q", "samples": [0.0, 0.0, 0.1, 0.2, 0.0]},
        ],
    }
    payload.update(overrides)
    return payload


class TestCircuit:
    def test_valid_bell_circuit_passes(self) -> None:
        validate_artifact_payload("circuit", circuit())

    def test_qubit_bounds(self) -> None:
        with pytest.raises(ValidationFailed, match="qubits"):
            validate_artifact_payload("circuit", circuit(qubits=0))
        with pytest.raises(ValidationFailed, match="qubits"):
            validate_artifact_payload("circuit", circuit(qubits=33))
        with pytest.raises(ValidationFailed, match="qubits"):
            validate_artifact_payload("circuit", circuit(qubits="two"))

    def test_qubit_index_out_of_range(self) -> None:
        bad = circuit()
        bad["operations"][0]["targets"] = [2]  # qubits=2 → 合法下标只有 0/1
        with pytest.raises(ValidationFailed, match="out of range"):
            validate_artifact_payload("circuit", bad)

    def test_bool_qubit_index_rejected(self) -> None:
        bad = circuit()
        bad["operations"][0]["targets"] = [True]  # bool 是 int 子类，须显式拒绝
        with pytest.raises(ValidationFailed, match="ints"):
            validate_artifact_payload("circuit", bad)

    def test_single_qubit_gate_arity(self) -> None:
        bad = circuit()
        bad["operations"][0]["targets"] = [0, 1]  # H 两个 target
        with pytest.raises(ValidationFailed, match="single-qubit"):
            validate_artifact_payload("circuit", bad)
        bad2 = circuit()
        bad2["operations"][0]["controls"] = [1]  # H 带 control
        with pytest.raises(ValidationFailed, match="single-qubit"):
            validate_artifact_payload("circuit", bad2)

    def test_measure_no_controls(self) -> None:
        bad = circuit()
        bad["operations"][2]["targets"] = [0]  # 排除"重复量子比特"路径，单测 MEASURE 规则
        bad["operations"][2]["controls"] = [1]
        with pytest.raises(ValidationFailed, match="MEASURE"):
            validate_artifact_payload("circuit", bad)

    def test_control_and_target_overlap_rejected(self) -> None:
        bad = circuit()
        bad["operations"][1]["targets"] = [0]  # CNOT control=0 target=0
        with pytest.raises(ValidationFailed, match="duplicate qubit"):
            validate_artifact_payload("circuit", bad)

    def test_swap_arity(self) -> None:
        payload = circuit(
            operations=[{"id": "op-0", "gate": "SWAP", "targets": [0, 1]}]
        )
        validate_artifact_payload("circuit", payload)
        bad = circuit(operations=[{"id": "op-0", "gate": "SWAP", "targets": [0]}])
        with pytest.raises(ValidationFailed, match="symmetric"):
            validate_artifact_payload("circuit", bad)

    def test_duplicate_operation_id_rejected(self) -> None:
        payload = circuit(
            operations=[
                {"id": "op-0", "gate": "H", "targets": [0]},
                {"id": "op-0", "gate": "X", "targets": [1]},
            ]
        )
        with pytest.raises(ValidationFailed, match="duplicate operation"):
            validate_artifact_payload("circuit", payload)

    def test_unknown_gate_passes_with_index_check_only(self) -> None:
        payload = circuit(operations=[{"id": "op-0", "gate": "ZZZNEW", "targets": [0, 1]}])
        validate_artifact_payload("circuit", payload)  # 门库扩展留边界
        bad = circuit(operations=[{"id": "op-0", "gate": "ZZZNEW", "targets": [9]}])
        with pytest.raises(ValidationFailed, match="out of range"):
            validate_artifact_payload("circuit", bad)

    def test_empty_gate_rejected(self) -> None:
        payload = circuit(operations=[{"id": "op-0", "gate": "", "targets": [0]}])
        with pytest.raises(ValidationFailed, match="non-empty"):
            validate_artifact_payload("circuit", payload)


class TestCounts:
    def test_valid_counts_pass(self) -> None:
        validate_artifact_payload("counts", counts())

    def test_sum_must_equal_shots(self) -> None:
        with pytest.raises(ValidationFailed, match="sum"):
            validate_artifact_payload("counts", counts(shots=1023))

    def test_bitstring_length_must_equal_qubits(self) -> None:
        bad = counts(counts={"000": 512, "111": 512})  # 3 位串 vs qubits=2
        with pytest.raises(ValidationFailed, match="length"):
            validate_artifact_payload("counts", bad)

    def test_binary_keys_only(self) -> None:
        bad = counts(counts={"0a": 512, "11": 512})
        with pytest.raises(ValidationFailed, match="0/1"):
            validate_artifact_payload("counts", bad)

    def test_nonpositive_shots_rejected(self) -> None:
        with pytest.raises(ValidationFailed, match="shots"):
            validate_artifact_payload("counts", counts(shots=0))

    def test_negative_count_rejected(self) -> None:
        bad = counts(counts={"00": -1, "11": 1025})
        with pytest.raises(ValidationFailed, match="non-negative"):
            validate_artifact_payload("counts", bad)

    def test_float_count_rejected(self) -> None:
        bad = counts(counts={"00": 498.5, "11": 525.5})
        with pytest.raises(ValidationFailed, match="must be an int"):
            validate_artifact_payload("counts", bad)


class TestWaveform:
    def test_valid_waveform_passes(self) -> None:
        validate_artifact_payload("waveform", waveform())

    @pytest.mark.parametrize(
        "bad_samples",
        [
            [0.0],                                        # 太短（<2）
            [0.0] * 65537,                                # 太长（>65536）
            [0.0, float("nan")],                          # 非有限
            [0.0, float("inf")],                          # 非有限
            [0.0, "0.5"],                                 # 非数值
        ],
    )
    def test_bad_samples_rejected(self, bad_samples: list) -> None:
        bad = waveform(channels=[{"label": "Q0 I", "samples": bad_samples}])
        with pytest.raises(ValidationFailed):
            validate_artifact_payload("waveform", bad)

    def test_sample_rate_must_be_positive_finite(self) -> None:
        with pytest.raises(ValidationFailed):
            validate_artifact_payload("waveform", waveform(sample_rate_ns=0.0))
        with pytest.raises(ValidationFailed):
            validate_artifact_payload("waveform", waveform(sample_rate_ns=-1.0))
        with pytest.raises(ValidationFailed):
            validate_artifact_payload("waveform", waveform(sample_rate_ns=float("nan")))

    def test_empty_channels_rejected(self) -> None:
        with pytest.raises(ValidationFailed, match="channels"):
            validate_artifact_payload("waveform", waveform(channels=[]))

    def test_blank_label_rejected(self) -> None:
        bad = waveform(channels=[{"label": "", "samples": [0.0, 1.0]}])
        with pytest.raises(ValidationFailed, match="label"):
            validate_artifact_payload("waveform", bad)


class TestUnknownType:
    def test_unknown_type_degrades_gracefully(self) -> None:
        validate_artifact_payload("mystery", {"anything": True})

    def test_known_type_non_dict_payload_rejected(self) -> None:
        with pytest.raises(ValidationFailed):
            validate_artifact_payload("counts", [1, 2, 3])
