"""HardwareNode.metrics 生成与漂移（契约 §4 v1.2，v1 分片）。

**数据性质声明（与契约一致）**：本模块产出的是 **simulated** 数据——
按文献合理区间随机生成并随 tick 缓慢漂移的监控/拓扑数值，**不是硬件
观测值**；文档、API 消费者与 UI 均不得将其表述为实测。

- QPU：rows×cols 网格拓扑。qubit id = ``row*cols + col``（与 (row,col)
  一一对应）；couplers = 全部"右邻/下邻"相邻对；逐比特 T1/T2（µs，
  约束 ``t2 ≤ 2*t1`` 物理合理性上界）与 readout/单比特门保真度、
  逐耦合器两比特门保真度。
- CPU：``cpu_cores``/``memory_total_gb`` 来自配置，``cpu_usage``/
  ``memory_used_gb`` 为模拟初值（随机游走由模拟器驱动，见 simulator）。
- GPU：``vram_total_gb`` 来自配置，``vram_used_gb`` 为模拟初值。

确定性：随机源 ``random.Random`` 由调用方注入（种子可复现，测试不依赖
真实随机）。模拟区间（工程选择，标注为模拟）：
T1 20–80µs、T2 10–60µs、readout 0.95–0.995、1Q 0.995–0.9999、
2Q 0.98–0.995。
"""

from __future__ import annotations

import copy
import random
from typing import Any

from qap.core.config import HardwareNodeConfig

#: 模拟区间常量（契约 §4 v1.2 "模拟区间（工程选择，标注为模拟）"）
T1_RANGE_US = (20.0, 80.0)
T2_RANGE_US = (10.0, 60.0)
READOUT_FIDELITY_RANGE = (0.95, 0.995)
SQ_FIDELITY_RANGE = (0.995, 0.9999)
TQ_FIDELITY_RANGE = (0.98, 0.995)
#: CPU/GPU 动态初值区间（used 占总量的比例下/上界）
CPU_USAGE_INIT_RANGE = (0.05, 0.35)
MEMORY_USED_RATIO_RANGE = (0.2, 0.6)
VRAM_USED_RATIO_RANGE = (0.05, 0.4)

#: 数值精度：T1/T2 保留 1 位小数，保真度保留 4 位（≤0.0002 的漂移可见）
_COHERENCE_DECIMALS = 1
_FIDELITY_DECIMALS = 4


def _uniform_round(rng: random.Random, low: float, high: float, digits: int) -> float:
    """区间内均匀取值并保留指定小数位。"""
    return round(rng.uniform(low, high), digits)


def build_initial_metrics(
    node_config: HardwareNodeConfig, rng: random.Random
) -> dict[str, Any] | None:
    """按 kind 生成节点 metrics 初值（simulated，非硬件观测）。

    :returns: 规格键齐全时返回契约形状的 dict；规格缺失返回 None
        （契约 §4：metrics 可缺省，前端降级）。
    """
    if node_config.kind == "qpu":
        if node_config.topology is None:
            return None
        return _build_qpu_metrics(node_config.topology.rows, node_config.topology.cols, rng)
    if node_config.kind == "gpu":
        if node_config.vram_total_gb is None:
            return None
        return {
            "vram_total_gb": node_config.vram_total_gb,
            "vram_used_gb": round(
                node_config.vram_total_gb * rng.uniform(*VRAM_USED_RATIO_RANGE), 1
            ),
        }
    if node_config.kind == "cpu":
        if node_config.cpu_cores is None or node_config.memory_total_gb is None:
            return None
        return {
            "cpu_cores": node_config.cpu_cores,
            "cpu_usage": round(rng.uniform(*CPU_USAGE_INIT_RANGE), 3),
            "memory_total_gb": node_config.memory_total_gb,
            "memory_used_gb": round(
                node_config.memory_total_gb * rng.uniform(*MEMORY_USED_RATIO_RANGE), 1
            ),
        }
    raise ValueError(f"unknown node kind {node_config.kind!r}")  # pragma: no cover


def _build_qpu_metrics(rows: int, cols: int, rng: random.Random) -> dict[str, Any]:
    """构造 QPU 网格拓扑 metrics：逐比特保真度 + 相邻对耦合器。

    T2 先于 T1 上界裁剪：保证不变量 ``t2_us ≤ 2*t1_us`` 构造性成立。
    """
    qubits: list[dict[str, Any]] = []
    for row in range(rows):
        for col in range(cols):
            t1 = _uniform_round(rng, *T1_RANGE_US, _COHERENCE_DECIMALS)
            t2_cap = min(T2_RANGE_US[1], 2.0 * t1)  # 物理合理性上界
            t2 = _uniform_round(rng, T2_RANGE_US[0], t2_cap, _COHERENCE_DECIMALS)
            qubits.append(
                {
                    "id": row * cols + col,  # 契约：id = row*cols + col
                    "t1_us": t1,
                    "t2_us": t2,
                    "readout_fidelity": _uniform_round(
                        rng, *READOUT_FIDELITY_RANGE, _FIDELITY_DECIMALS
                    ),
                    "sq_fidelity": _uniform_round(
                        rng, *SQ_FIDELITY_RANGE, _FIDELITY_DECIMALS
                    ),
                }
            )
    couplers: list[dict[str, Any]] = []
    for row in range(rows):
        for col in range(cols):
            qubit_id = row * cols + col
            if col + 1 < cols:  # 右邻
                couplers.append(
                    {
                        "a": qubit_id,
                        "b": qubit_id + 1,
                        "tq_fidelity": _uniform_round(
                            rng, *TQ_FIDELITY_RANGE, _FIDELITY_DECIMALS
                        ),
                    }
                )
            if row + 1 < rows:  # 下邻
                couplers.append(
                    {
                        "a": qubit_id,
                        "b": qubit_id + cols,
                        "tq_fidelity": _uniform_round(
                            rng, *TQ_FIDELITY_RANGE, _FIDELITY_DECIMALS
                        ),
                    }
                )
    return {
        "qubits_count": rows * cols,
        "topology": {
            "layout": "grid",
            "rows": rows,
            "cols": cols,
            "qubits": qubits,
            "couplers": couplers,
        },
    }


#: 每 tick 保真度漂移幅度上界（契约 §4 v1.2：漂移幅度每 tick ≤ 0.0002）
FIDELITY_DRIFT_MAX = 0.0002
#: used 值随机游走步长（工程选择：CPU/GPU 用量的可感知缓变）
CPU_USAGE_DRIFT = 0.04
MEMORY_USED_DRIFT_GB = 2.0
VRAM_USED_DRIFT_GB = 1.0
#: 保真度下界 clamp 的保护值（区间 (0,1] 的开下界用极小正值守住）
_FIDELITY_FLOOR = 1e-6


def drift_node_metrics(kind: str, metrics: dict[str, Any], rng: random.Random) -> dict:
    """推进一个节点的 metrics 一拍（simulated 漂移；返回**新 dict**）。

    - QPU：readout/sq/tq 保真度均匀随机游走 ±0.0002 后 clamp (0,1]
      （4 位小数）；T1/T2 为静态规格（漂移仅作用于保真度与 used 值）；
    - CPU：``cpu_usage`` 游走 clamp [0,1]，``memory_used_gb`` 游走
      clamp [0, total]；
    - GPU：``vram_used_gb`` 游走 clamp [0, total]。

    构造性满足全部 §4 v1.2 不变量（可用 domain.invariants 复核）。
    """
    drifted = copy.deepcopy(metrics)
    if kind == "qpu":
        topology = drifted["topology"]
        for qubit in topology["qubits"]:
            qubit["readout_fidelity"] = _drift_fidelity(
                qubit["readout_fidelity"], rng
            )
            qubit["sq_fidelity"] = _drift_fidelity(qubit["sq_fidelity"], rng)
        for coupler in topology["couplers"]:
            coupler["tq_fidelity"] = _drift_fidelity(coupler["tq_fidelity"], rng)
        return drifted
    if kind == "cpu":
        usage = drifted["cpu_usage"] + rng.uniform(-CPU_USAGE_DRIFT, CPU_USAGE_DRIFT)
        drifted["cpu_usage"] = round(min(1.0, max(0.0, usage)), 3)
        total = drifted["memory_total_gb"]
        used = drifted["memory_used_gb"] + rng.uniform(
            -MEMORY_USED_DRIFT_GB, MEMORY_USED_DRIFT_GB
        )
        drifted["memory_used_gb"] = round(min(total, max(0.0, used)), 1)
        return drifted
    if kind == "gpu":
        total = drifted["vram_total_gb"]
        used = drifted["vram_used_gb"] + rng.uniform(
            -VRAM_USED_DRIFT_GB, VRAM_USED_DRIFT_GB
        )
        drifted["vram_used_gb"] = round(min(total, max(0.0, used)), 1)
        return drifted
    raise ValueError(f"unknown node kind {kind!r}")  # pragma: no cover


def _drift_fidelity(value: float, rng: random.Random) -> float:
    """保真度单步漂移：±0.0002 均匀游走 → clamp (0,1] → 4 位小数。"""
    walked = value + rng.uniform(-FIDELITY_DRIFT_MAX, FIDELITY_DRIFT_MAX)
    clamped = min(1.0, max(_FIDELITY_FLOOR, walked))
    return round(clamped, _FIDELITY_DECIMALS)
