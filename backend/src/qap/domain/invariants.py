"""对外校验函数：契约 §4 v1.2 全部不变量 + 不变量 5（v1.3）。

- :func:`validate_node_metrics`：HardwareNode.metrics 的结构化不变量——
  fidelity ∈ (0,1]；``t1/t2 > 0`` 且 ``t2 ≤ 2*t1``；used ≤ total（内存/
  显存）；``cpu_usage ∈ [0,1]``；coupler 端点 ∈ [0, qubits_count) 且为
  网格相邻对；grid 布局 qubit id 与 (row,col) 一一对应；
  ``qubits_count == rows*cols == len(qubits)``。
- :func:`validate_step_profiles`：不变量 5——``duration_ms ≥ 0``；
  ``peak_memory_mb > 0`` 或 null；finished 步必有起止时间戳且
  ``|duration_ms − (finished − started)| ≤ 50ms``（时间戳为毫秒精度
  ISO-8601 UTC，见 core.clock）。

二者是**测试与冒烟的对外断言工具**（生成侧构造性满足不变量；本模块
负责独立复核，任何违例抛 :class:`ValidationFailed`）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from qap.core.errors import ValidationFailed

#: 不变量 5 的时间戳-时长一致性容差（毫秒）
DURATION_TIMESTAMP_TOLERANCE_MS = 50.0


def _fail(message: str) -> None:
    raise ValidationFailed(f"metrics invariant violated: {message}")


def _check_unit_fidelity(value: float, label: str) -> None:
    if not 0.0 < float(value) <= 1.0:
        _fail(f"{label} fidelity must be within (0,1], got {value}")


def validate_node_metrics(kind: str, metrics: dict[str, Any] | None) -> None:
    """校验一个节点的 metrics 满足 §4 v1.2 不变量（None = 可缺省，通过）。

    :raises ValidationFailed: 任何不变量违例（消息指明字段与原因）。
    """
    if metrics is None:
        return
    if kind == "qpu":
        _validate_qpu_metrics(metrics)
    elif kind == "cpu":
        _validate_cpu_metrics(metrics)
    elif kind == "gpu":
        _validate_gpu_metrics(metrics)
    else:  # pragma: no cover - kind 已由配置校验收敛
        _fail(f"unknown node kind {kind!r}")


def _validate_qpu_metrics(metrics: dict[str, Any]) -> None:
    # v1.4 cloud-observed 分支：真机实拉拓扑（平台未提供保真度 → 全 null、
    # 无耦合器数据 → 空列表）——结构校验保留，物理量校验按"诚实为空"放行。
    if metrics.get("source") == "cloud-observed" or metrics.get("topology", {}).get(
        "layout"
    ) == "cloud":
        _validate_cloud_qpu_metrics(metrics)
        return
    topology = metrics.get("topology")
    if not isinstance(topology, dict):
        _fail("qpu metrics require a topology object")
    rows, cols = topology.get("rows"), topology.get("cols")
    qubits, couplers = topology.get("qubits") or [], topology.get("couplers") or []
    if not isinstance(rows, int) or not isinstance(cols, int) or rows < 1 or cols < 1:
        _fail(f"topology rows/cols must be positive ints, got {rows}x{cols}")
    count = metrics.get("qubits_count")
    if count != rows * cols or len(qubits) != rows * cols:
        _fail(
            f"qubits_count must equal rows*cols and len(qubits) "
            f"({rows}x{cols}={rows * cols}, count={count}, len={len(qubits)})"
        )
    seen_ids: set[int] = set()
    for qubit in qubits:
        qubit_id = qubit.get("id")
        if not isinstance(qubit_id, int) or not 0 <= qubit_id < count:
            _fail(f"qubit id out of range [0,{count}): {qubit_id!r}")
        if qubit_id in seen_ids:
            _fail(f"duplicate qubit id {qubit_id}")
        seen_ids.add(qubit_id)
        # 一一对应：id == row*cols + col（存在性由 id ∈ [0,count) + 唯一性
        # + 总数相等共同保证，无需重算坐标）
        t1, t2 = qubit.get("t1_us"), qubit.get("t2_us")
        if not isinstance(t1, (int, float)) or t1 <= 0:
            _fail(f"qubit {qubit_id} t1_us must be > 0, got {t1}")
        if not isinstance(t2, (int, float)) or t2 <= 0:
            _fail(f"qubit {qubit_id} t2_us must be > 0, got {t2}")
        if t2 > 2 * t1:
            _fail(f"qubit {qubit_id} t2_us ({t2}) exceeds 2*t1_us ({2 * t1})")
        _check_unit_fidelity(qubit.get("readout_fidelity"), f"qubit {qubit_id} readout")
        _check_unit_fidelity(qubit.get("sq_fidelity"), f"qubit {qubit_id} sq")
    seen_pairs: set[tuple[int, int]] = set()
    for coupler in couplers:
        a, b = coupler.get("a"), coupler.get("b")
        if (
            not isinstance(a, int) or not isinstance(b, int)
            or not 0 <= a < count or not 0 <= b < count
        ):
            _fail(f"coupler endpoints out of range [0,{count}): {a!r},{b!r}")
        pair = (min(a, b), max(a, b))
        if pair in seen_pairs:
            _fail(f"duplicate coupler pair {pair}")
        seen_pairs.add(pair)
        # 网格相邻：同行相邻列（|Δ|=1 且同行）或同列相邻行（|Δ|=cols 且同列）
        delta = abs(b - a)
        same_row = (a // cols) == (b // cols)
        same_col = (a % cols) == (b % cols)
        if not ((delta == 1 and same_row) or (delta == cols and same_col)):
            _fail(f"coupler ({a},{b}) is not a grid-adjacent pair")
        _check_unit_fidelity(coupler.get("tq_fidelity"), f"coupler ({a},{b}) tq")


def _validate_cloud_qpu_metrics(metrics: dict[str, Any]) -> None:
    """cloud-observed QPU metrics 校验（契约 §3 v1.4 / §4 v1.4）。

    与 simulated 形状的差异（诚实性约束）：
    - ``qubits_count == len(qubits)``（云拓扑非满网格，**不要求**
      rows*cols——rows/cols 仅为坐标极值 + 1 的画布尺寸）；
    - 每比特 t1/t2/readout/sq 必须**全为 None**（平台未提供保真度，
      出现数值即疑似伪造 → 拒绝）；
    - ``couplers`` 必须为空列表（平台未提供耦合器数据，同理）；
    - qubit id 仍要求 ∈ [0, count) 且唯一。
    """
    topology = metrics.get("topology")
    if not isinstance(topology, dict):
        _fail("qpu metrics require a topology object")
    rows, cols = topology.get("rows"), topology.get("cols")
    if not isinstance(rows, int) or not isinstance(cols, int) or rows < 1 or cols < 1:
        _fail(f"cloud topology rows/cols must be positive ints, got {rows}x{cols}")
    qubits, couplers = topology.get("qubits") or [], topology.get("couplers")
    if couplers != []:
        _fail(
            "cloud-observed topology must have empty couplers "
            "(platform does not provide coupler data; fabricating it is forbidden)"
        )
    count = metrics.get("qubits_count")
    if not isinstance(count, int) or count != len(qubits):
        _fail(f"qubits_count must equal len(qubits) (count={count}, len={len(qubits)})")
    seen_ids: set[int] = set()
    for qubit in qubits:
        qubit_id = qubit.get("id")
        if not isinstance(qubit_id, int) or not 0 <= qubit_id < count:
            _fail(f"qubit id out of range [0,{count}): {qubit_id!r}")
        if qubit_id in seen_ids:
            _fail(f"duplicate qubit id {qubit_id}")
        seen_ids.add(qubit_id)
        for field in ("t1_us", "t2_us", "readout_fidelity", "sq_fidelity"):
            if qubit.get(field) is not None:
                _fail(
                    f"qubit {qubit_id} {field} must be null in cloud-observed "
                    "topology (platform does not provide it)"
                )


def _validate_cpu_metrics(metrics: dict[str, Any]) -> None:
    usage = metrics.get("cpu_usage")
    if not isinstance(usage, (int, float)) or not 0.0 <= usage <= 1.0:
        _fail(f"cpu_usage must be within [0,1], got {usage}")
    total, used = metrics.get("memory_total_gb"), metrics.get("memory_used_gb")
    if not isinstance(total, (int, float)) or total <= 0:
        _fail(f"memory_total_gb must be > 0, got {total}")
    if not isinstance(used, (int, float)) or used < 0 or used > total:
        _fail(f"memory_used_gb must be within [0,{total}], got {used}")


def _validate_gpu_metrics(metrics: dict[str, Any]) -> None:
    total, used = metrics.get("vram_total_gb"), metrics.get("vram_used_gb")
    if not isinstance(total, (int, float)) or total <= 0:
        _fail(f"vram_total_gb must be > 0, got {total}")
    if not isinstance(used, (int, float)) or used < 0 or used > total:
        _fail(f"vram_used_gb must be within [0,{total}], got {used}")


def _parse_iso_ms(stamp: str) -> datetime:
    """毫秒精度 ISO-8601 UTC（Z 后缀）→ datetime。"""
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(timezone.utc)


def validate_step_profiles(task: Any) -> None:
    """校验一个 Task 全部 Step 的实测 profile（不变量 5）。

    - ``duration_ms`` 非 null 时 ≥ 0；``peak_memory_mb`` 非 null 时 > 0；
    - finished 步（succeeded/failed/cancelled 且曾被启动）：起止时间戳
      齐备且 ``|duration − span| ≤ 50ms``；
    - 级联取消（从未启动：无 started_at）的步骤 profile 应为 null。
    """
    for step in task.steps:
        if step.duration_ms is not None and step.duration_ms < 0:
            _fail(f"step {step.id} duration_ms must be >= 0, got {step.duration_ms}")
        if step.peak_memory_mb is not None and step.peak_memory_mb <= 0:
            _fail(
                f"step {step.id} peak_memory_mb must be > 0 or null, "
                f"got {step.peak_memory_mb}"
            )
        finished = step.status in ("succeeded", "failed", "cancelled")
        if not finished:
            continue
        if step.started_at is None:
            if step.status == "cancelled":
                continue  # 级联取消（从未启动）：无执行即无 profile（null 语义）
            _fail(
                f"step {step.id} status={step.status} but started_at is null"
            )
        if step.finished_at is None:
            _fail(f"step {step.id} has started_at but finished_at is null")
        span_ms = (
            _parse_iso_ms(step.finished_at) - _parse_iso_ms(step.started_at)
        ).total_seconds() * 1000
        if step.duration_ms is None:
            _fail(f"step {step.id} finished but duration_ms is null")
        if abs(span_ms - step.duration_ms) > DURATION_TIMESTAMP_TOLERANCE_MS:
            _fail(
                f"step {step.id} duration_ms={step.duration_ms} deviates from "
                f"timestamp span {span_ms:.1f}ms beyond "
                f"{DURATION_TIMESTAMP_TOLERANCE_MS}ms tolerance"
            )
