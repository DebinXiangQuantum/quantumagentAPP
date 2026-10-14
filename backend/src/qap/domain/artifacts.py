"""Artifact 载荷校验（契约 §6）：非法载荷在生成侧即拒绝。

已知 type 及其约束：
- ``circuit``：qubits ∈ [1,32]；操作 gate 非空；targets/controls 的量子比特
  下标 ⊂ [0, qubits)；已知单量子门 targets 恰 1 个且无 controls；已知受控
  两量子门恰 1 control + 1 target；SWAP 类两量子对称门 2 targets 无 controls；
  MEASURE 至少 1 target 且无 controls。**未知 gate 名放行**（只校验下标与
  非空），为未来门库扩展留边界——前端对未知内容本就要求优雅降级。
- ``counts``：shots > 0；键为 0/1 串且长度 == qubits；值非负整数；
  ``sum(counts) == shots``（不变量 2，测试覆盖）。
- ``waveform``：sample_rate_ns > 0 且有限；channels ≥ 1；每通道 samples
  长度 ∈ [2, 65536] 且全部 isfinite；label 非空。
未知 type：payload 只需是 JSON 对象（信封层已保证 dict），前端降级渲染。
"""

from __future__ import annotations

import math
from typing import Any

from qap.core.errors import ValidationFailed

#: circuit artifact 的量子比特数上下界（契约 §6）
CIRCUIT_MAX_QUBITS = 32
#: waveform 每通道采样点数上下界（契约 §6）
WAVEFORM_MIN_SAMPLES = 2
WAVEFORM_MAX_SAMPLES = 65536

#: 已知单量子门（targets 恰 1、无 controls）
SINGLE_QUBIT_GATES = frozenset(
    {"H", "X", "Y", "Z", "S", "SDG", "T", "TDG", "RX", "RY", "RZ", "P", "U", "I"}
)
#: 已知受控两量子门（controls 恰 1、targets 恰 1）
CONTROLLED_GATES = frozenset({"CNOT", "CX", "CY", "CZ", "CRX", "CRY", "CRZ", "CP"})
#: 已知两量子对称门（targets 恰 2、无 controls）
SYMMETRIC_TWO_QUBIT_GATES = frozenset({"SWAP", "ISWAP", "XX", "YY", "ZZ"})
#: v1.5 双比特 ZZ 旋转（targets 恰 2 + 角度；真机分解 CX·RZ·CX）
RZZ_GATE = "RZZ"
#: v1.5 需要角度的单比特旋转门（params=[θ] 正式 / 旧 theta 字段兼容）
ROTATION_GATES = frozenset({"RX", "RY", "RZ"})
#: 测量伪门（targets ≥ 1、无 controls）
MEASURE_GATE = "MEASURE"


def _fail(artifact_type: str, reason: str) -> None:
    """以统一错误码抛出校验失败（API 层映射 422 / SSE error 事件）。"""
    raise ValidationFailed(f"invalid {artifact_type!r} artifact payload: {reason}")


def _validate_qubit_index(value: Any, qubits: int, artifact_type: str, field: str) -> int:
    """校验单个量子比特下标：必须是真 int（bool 排除）且 ⊂ [0, qubits)。"""
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(artifact_type, f"{field} entries must be ints, got {value!r}")
    if not 0 <= value < qubits:
        _fail(artifact_type, f"{field} index {value} out of range [0,{qubits})")
    return value


def _finite_or_none(value: Any) -> float | None:
    """数值且有限 → float；否则 None（bool 显式排除——Python 的 bool 是 int）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _resolve_rotation_angle(op: dict[str, Any]) -> float | None:
    """旋转门角度双轨解析（§6 v1.5）：params[0]（正式）优先，旧 theta 兼容。

    返回有限角度或 None（缺角度/非有限/形状非法均 None，调用方拒绝）。
    params 字段本身存在时必须是有限数列表（形状校验在 _validate_circuit）。
    """
    params = op.get("params")
    if isinstance(params, list) and params:
        return _finite_or_none(params[0])
    return _finite_or_none(op.get("theta"))


def _validate_circuit(payload: dict[str, Any]) -> None:
    """circuit 载荷校验（见模块 docstring 的门级约束）。"""
    qubits = payload.get("qubits")
    if isinstance(qubits, bool) or not isinstance(qubits, int):
        _fail("circuit", "qubits must be an int")
    if not 1 <= qubits <= CIRCUIT_MAX_QUBITS:
        _fail("circuit", f"qubits must be within [1,{CIRCUIT_MAX_QUBITS}], got {qubits}")
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        _fail("circuit", "operations must be a non-empty list")
    seen_op_ids: set[str] = set()
    measured_qubits: set[int] = set()  # v1.5 测量后不变量的已测量比特
    for op in operations:
        if not isinstance(op, dict):
            _fail("circuit", "each operation must be an object")
        op_id = op.get("id")
        if not isinstance(op_id, str) or not op_id:
            _fail("circuit", "operation.id must be a non-empty string")
        if op_id in seen_op_ids:
            _fail("circuit", f"duplicate operation id {op_id!r}")
        seen_op_ids.add(op_id)
        gate = op.get("gate")
        if not isinstance(gate, str) or not gate:
            _fail("circuit", "operation.gate must be a non-empty string")
        targets = op.get("targets")
        if not isinstance(targets, list) or not targets:
            _fail("circuit", f"operation {op_id}: targets must be a non-empty list")
        controls = op.get("controls", [])
        if not isinstance(controls, list):
            _fail("circuit", f"operation {op_id}: controls must be a list when present")
        for entry in targets:
            _validate_qubit_index(entry, qubits, "circuit", f"operation {op_id} targets")
        for entry in controls:
            _validate_qubit_index(entry, qubits, "circuit", f"operation {op_id} controls")
        # 量子比特不能在同一操作里重复出现（CNOT 控制=目标一类手误）。
        combined = list(targets) + list(controls)
        if len(combined) != len(set(combined)):
            _fail("circuit", f"operation {op_id}: duplicate qubit in targets/controls")
        # v1.5 params 形状：存在即必须是有限数列表（无参数门携带合法 params 放行）
        params = op.get("params")
        if params is not None:
            if not isinstance(params, list) or not all(
                _finite_or_none(v) is not None for v in params
            ):
                _fail("circuit", f"operation {op_id}: params must be a list of finite numbers")
        # v1.5 测量后不变量：某比特 MEASURE 后任何作用它的操作（含控制位/再测量）非法
        if measured_qubits & (set(targets) | set(controls)):
            _fail(
                "circuit",
                f"operation {op_id} ({gate}) acts on a qubit already measured; "
                f"no operations may follow a qubit's MEASURE",
            )
        if gate == MEASURE_GATE:
            if controls:
                _fail("circuit", "MEASURE must not have controls")
            measured_qubits.update(int(q) for q in targets)
        elif gate == RZZ_GATE:
            if len(targets) != 2 or controls:
                _fail("circuit", "RZZ takes exactly 2 targets and no controls")
            if _resolve_rotation_angle(op) is None:
                _fail("circuit", "RZZ requires a finite angle (params[0] or theta)")
        elif gate in SINGLE_QUBIT_GATES:
            if len(targets) != 1 or controls:
                _fail("circuit", f"single-qubit gate {gate} takes exactly 1 target, no controls")
            if gate in ROTATION_GATES and _resolve_rotation_angle(op) is None:
                _fail("circuit", f"{gate} requires a finite angle (params[0] or theta)")
        elif gate in CONTROLLED_GATES:
            if len(controls) != 1 or len(targets) != 1:
                _fail("circuit", f"controlled gate {gate} takes 1 control and 1 target")
        elif gate in SYMMETRIC_TWO_QUBIT_GATES:
            if len(targets) != 2 or controls:
                _fail("circuit", f"symmetric gate {gate} takes exactly 2 targets, no controls")


def _validate_counts(payload: dict[str, Any]) -> None:
    """counts 载荷校验（不变量 2：计数守恒 + 比特串长度 == qubits）。"""
    shots = payload.get("shots")
    if isinstance(shots, bool) or not isinstance(shots, int) or shots <= 0:
        _fail("counts", f"shots must be a positive int, got {shots!r}")
    qubits = payload.get("qubits")
    if isinstance(qubits, bool) or not isinstance(qubits, int):
        _fail("counts", "qubits must be an int")
    if not 1 <= qubits <= CIRCUIT_MAX_QUBITS:
        _fail("counts", f"qubits must be within [1,{CIRCUIT_MAX_QUBITS}], got {qubits}")
    counts = payload.get("counts")
    if not isinstance(counts, dict) or not counts:
        _fail("counts", "counts must be a non-empty object")
    total = 0
    for key, value in counts.items():
        if not isinstance(key, str) or not key or set(key) - {"0", "1"}:
            _fail("counts", f"counts keys must be non-empty 0/1 strings, got {key!r}")
        if len(key) != qubits:
            _fail("counts", f"bitstring {key!r} length {len(key)} != qubits {qubits}")
        if isinstance(value, bool) or not isinstance(value, int):
            _fail("counts", f"counts[{key!r}] must be an int, got {value!r}")
        if value < 0:
            _fail("counts", f"counts[{key!r}] must be non-negative, got {value}")
        total += value
    if total != shots:
        _fail("counts", f"sum(counts)={total} != shots={shots}")


def _validate_waveform(payload: dict[str, Any]) -> None:
    """waveform 载荷校验（采样率 > 0；samples 长度界内且全部有限）。"""
    sample_rate = payload.get("sample_rate_ns")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, float)):
        _fail("waveform", "sample_rate_ns must be a number")
    sample_rate = float(sample_rate)
    if not math.isfinite(sample_rate) or sample_rate <= 0:
        _fail("waveform", f"sample_rate_ns must be finite and > 0, got {sample_rate}")
    unit = payload.get("unit")
    if not isinstance(unit, str) or not unit:
        _fail("waveform", "unit must be a non-empty string")
    channels = payload.get("channels")
    if not isinstance(channels, list) or not channels:
        _fail("waveform", "channels must be a non-empty list")
    for idx, channel in enumerate(channels):
        if not isinstance(channel, dict):
            _fail("waveform", f"channel[{idx}] must be an object")
        label = channel.get("label")
        if not isinstance(label, str) or not label:
            _fail("waveform", f"channel[{idx}].label must be a non-empty string")
        samples = channel.get("samples")
        if not isinstance(samples, list):
            _fail("waveform", f"channel[{idx}].samples must be a list")
        if not WAVEFORM_MIN_SAMPLES <= len(samples) <= WAVEFORM_MAX_SAMPLES:
            _fail(
                "waveform",
                f"channel[{idx}].samples length {len(samples)} outside "
                f"[{WAVEFORM_MIN_SAMPLES},{WAVEFORM_MAX_SAMPLES}]",
            )
        for sample in samples:
            if isinstance(sample, bool) or not isinstance(sample, (int, float)):
                _fail("waveform", f"channel[{idx}].samples entries must be numbers")
            if not math.isfinite(float(sample)):
                _fail("waveform", f"channel[{idx}].samples contains non-finite value")


_VALIDATORS = {
    "circuit": _validate_circuit,
    "counts": _validate_counts,
    "waveform": _validate_waveform,
}


def validate_artifact_payload(artifact_type: Any, payload: Any) -> None:
    """按 type 校验 artifact 载荷；已知 type 违反约束抛 :class:`ValidationFailed`。

    未知 type 放行（前端契约要求对未知 type 优雅降级为 JSON 卡片），
    但 payload 必须是 dict——由 Artifact 信封模型的字段类型保证。
    """
    if artifact_type in _VALIDATORS:
        if not isinstance(payload, dict):
            _fail(str(artifact_type), "payload must be a JSON object")
        _VALIDATORS[artifact_type](payload)
