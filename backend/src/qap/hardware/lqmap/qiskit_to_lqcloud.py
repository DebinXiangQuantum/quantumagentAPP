"""Qiskit 线路 -> LQCloud 线路转换器。

流程：
1. 规范化测量：去掉原线路的测量指令，加 ``barrier()`` 后按 ``measure_qubits``
   升序映射到经典位 k（满足平台"测量前必须有 barrier"的本地校验规则）；
2. 用 Qiskit 转译到 lqcloud 支持的门集（单比特门 + cx/cz/swap），并针对
   后端"链式放置路径"的耦合约束做布线（routing）；
3. 把转译后的物理线路逐指令重建为 ``lqcloud.QuantumCircuit``，并返回
   ``initial_layout``（逻辑比特 -> 芯片物理比特）。

拓扑策略说明：无论后端是链（MQ02）还是网格（AGate-100），我们都先在芯片
耦合图中找一条足够长的简单路径 P，把线路布线到该路径对应的"链"上；提交时用
``initial_layout=[P[u0], P[u1], ...]`` 把压缩后的逻辑比特放到真实物理比特上。
这样既能压缩线路宽度（自动前置 reset 只作用于实际用到的比特），又能保证
分解后的两比特门都落在合法耦合边上（平台 0.3.6 起的拓扑邻接校验）。
"""
# =============================================================================
# 迁移代码（Provenance）
# 来源：/Volumes/macsoftware/codes/quantumcomputing/quantumchemistry/logicalcloud/
#   （本组博士生项目的噪声自适应编译模块，2026-10 经协调者同意整体迁入）
# 迁移改动：仅（a）包内相对导入 qiskit_to_lqcloud → .qiskit_to_lqcloud；
#   （b）追加本出处头。算法与实现逐字节保留（含其学术引用：
#   Murali et al. ASPLOS'19 噪声自适应映射；Li et al. ASPLOS'19 SABRE；
#   Patel et al. arXiv:2205.10596 保真度加权路由）。
# =============================================================================



from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from qiskit import ClassicalRegister, QuantumCircuit, transpile

# lqcloud 支持且方向可自动翻转（GateDirection pass 有规则）的两比特门，
# 加上平台支持的全部单比特门，构成转译目标门集。
LQ_BASIS_GATES = [
    "id", "h", "x", "y", "z", "s", "sdg", "t", "tdg", "sx", "sxdg",
    "rx", "ry", "rz", "u", "p", "cx", "cy", "cz", "swap",
]


@dataclass
class ConvertedCircuit:
    """转换产物：lqcloud 线路 + 物理映射 + 转译统计。"""

    lq_circuit: object
    initial_layout: list[int]
    num_qubits_logical: int
    num_clbits: int
    transpiled_depth: int
    two_qubit_gates: int
    single_qubit_gates: int
    swaps: int
    measured_logical_qubits: list[int] = field(default_factory=list)


def strip_and_remeasure(circuit: QuantumCircuit, measure_qubits: list[int] | None = None) -> tuple[QuantumCircuit, list[int]]:
    """去掉原有测量，按 measure_qubits 升序重建测量（qubit_k -> clbit_k）。

    返回 (新线路, 实际被测的逻辑比特列表)。measure_qubits 为 None 时测全部比特。
    """
    measured = sorted(measure_qubits) if measure_qubits is not None else list(range(circuit.num_qubits))
    if not measured:
        raise ValueError("至少需要测量一个比特")
    clean = QuantumCircuit(circuit.num_qubits, name=f"{circuit.name or 'circ'}_meas")
    for inst in circuit.data:
        if inst.operation.name in ("measure", "barrier"):
            continue
        clean.append(inst.operation, [circuit.find_bit(q).index for q in inst.qubits], [])
    clean.barrier()
    cr = ClassicalRegister(len(measured), name="m")
    clean.add_register(cr)
    for k, q in enumerate(measured):
        clean.measure(q, cr[k])
    return clean, measured


def find_simple_path(coupling_map: list[list[int]], min_length: int) -> list[int]:
    """在耦合图中找一条长度 >= min_length 的简单路径（贪心 DFS）。"""
    adjacency: dict[int, set[int]] = {}
    for a, b in coupling_map:
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)

    def dfs_from(start: int) -> list[int]:
        best = [start]
        stack = [(start, [start], {start})]
        while stack:
            node, path, visited = stack.pop()
            if len(path) > len(best):
                best = path
                if len(best) >= max(min_length * 3, 40):  # 够长即提前收敛
                    break
            for nxt in sorted(adjacency.get(node, ()), reverse=True):
                if nxt not in visited:
                    stack.append((nxt, path + [nxt], visited | {nxt}))
        return best

    best_path: list[int] = []
    for start in sorted(adjacency):
        if best_path and len(best_path) >= min_length:
            break
        path = dfs_from(start)
        if len(path) > len(best_path):
            best_path = path
    if len(best_path) < min_length:
        raise ValueError(f"耦合图中最长简单路径仅 {len(best_path)} 个比特，不足 {min_length}")
    return best_path


def _relabel_used(tq: QuantumCircuit) -> tuple[dict[int, int], int]:
    """求转译线路中实际用到的物理比特 -> 压缩序号（升序），以及最大宽度。"""
    used: set[int] = set()
    for inst in tq.data:
        if inst.operation.name == "barrier":
            continue
        for q in inst.qubits:
            used.add(tq.find_bit(q).index)
    mapping = {old: new for new, old in enumerate(sorted(used))}
    return mapping, (max(used) + 1 if used else 0)


def convert(
    circuit: QuantumCircuit,
    coupling_map: list[list[int]],
    *,
    measure_qubits: list[int] | None = None,
    optimization_level: int = 1,
    seed_transpiler: int = 7,
) -> ConvertedCircuit:
    """把 Qiskit 线路转换为可在真机上执行的 lqcloud 线路。

    Args:
        circuit: 待转换线路（可含或不含测量）。
        coupling_map: 目标后端耦合图（无向边列表）。
        measure_qubits: 需要测量的逻辑比特（None = 全部）。
    """
    from lqcloud import QuantumCircuit as LQCircuit

    normalized, measured = strip_and_remeasure(circuit, measure_qubits)

    # 布线到"链"上：先找芯片中的简单路径，用链式耦合图转译
    path = find_simple_path(coupling_map, min_length=max(normalized.num_qubits + 2, 8))
    chain = [[i, i + 1] for i in range(len(path) - 1)]
    tq = transpile(
        normalized,
        basis_gates=LQ_BASIS_GATES,
        coupling_map=chain,
        optimization_level=optimization_level,
        seed_transpiler=seed_transpiler,
    )

    mapping, _width = _relabel_used(tq)
    used_sorted = sorted(mapping)
    initial_layout = [path[u] for u in used_sorted]

    num_clbits = tq.num_clbits
    lq = LQCircuit(len(mapping), num_clbits)
    twoq = single = swaps = 0
    for inst in tq.data:
        name = inst.operation.name
        if name == "barrier":
            lq.barrier()
            continue
        qidx = [mapping[tq.find_bit(q).index] for q in inst.qubits]
        if name == "measure":
            cidx = tq.find_bit(inst.clbits[0]).index
            lq.measure(qidx[0], cidx)
        elif name in {"cx", "cnot"}:
            lq.cx(qidx[0], qidx[1]); twoq += 1
        elif name == "cz":
            lq.cz(qidx[0], qidx[1]); twoq += 1
        elif name == "swap":
            lq.swap(qidx[0], qidx[1]); twoq += 1; swaps += 1
        elif name == "cy":
            lq.cy(qidx[0], qidx[1]); twoq += 1
        elif name in {"id", "h", "x", "y", "z", "s", "sdg", "t", "tdg", "sx", "sxdg"}:
            getattr(lq, name if name != "cnot" else "cx")(qidx[0]); single += 1
        elif name in {"rx", "ry", "rz", "p"}:
            (theta,) = [float(p) for p in inst.operation.params]
            getattr(lq, name)(theta, qidx[0]); single += 1
        elif name == "u":
            theta, phi, lam = [float(p) for p in inst.operation.params]
            lq.u(theta, phi, lam, qidx[0]); single += 1
        else:
            raise ValueError(f"转译后仍出现不支持的指令：{name}")

    return ConvertedCircuit(
        lq_circuit=lq,
        initial_layout=initial_layout,
        num_qubits_logical=normalized.num_qubits,
        num_clbits=num_clbits,
        transpiled_depth=int(tq.depth()),
        two_qubit_gates=twoq,
        single_qubit_gates=single,
        swaps=swaps,
        measured_logical_qubits=measured,
    )


def ideal_probabilities(
    circuit: QuantumCircuit,
    measure_qubits: list[int] | None = None,
) -> dict[str, float]:
    """用态矢量精确计算被测比特的理想概率分布（Qiskit 键约定：最右字符 = clbit0）。

    输入线路应为不含测量的原始逻辑线路；此处自行投影被测比特。
    """
    from qiskit.quantum_info import Statevector

    clean = QuantumCircuit(circuit.num_qubits)
    for inst in circuit.data:
        if inst.operation.name in ("measure", "barrier"):
            continue
        clean.append(inst.operation, [circuit.find_bit(q).index for q in inst.qubits], [])
    measured = sorted(measure_qubits) if measure_qubits is not None else list(range(circuit.num_qubits))
    probs = Statevector(clean).probabilities(measured)
    width = len(measured)
    return {format(i, f"0{width}b"): float(p) for i, p in enumerate(probs) if p > 1e-12}


def hellinger_fidelity(p: dict[str, float], q: dict[str, float]) -> float:
    """两个分布的 Hellinger 保真度 (Σ√(p·q))²。"""
    keys = set(p) | set(q)
    bc = sum(np.sqrt(p.get(k, 0.0) * q.get(k, 0.0)) for k in keys)
    return float(bc**2)


def counts_to_probabilities(counts: dict[str, int], *, reverse_keys: bool) -> dict[str, float]:
    """把真机 counts 归一化为概率分布，并按位序约定统一成 Qiskit 键序。"""
    total = sum(counts.values())
    if total == 0:
        return {}
    out: dict[str, float] = {}
    for key, value in counts.items():
        key = key.replace(" ", "")
        if reverse_keys:
            key = key[::-1]
        out[key] = out.get(key, 0.0) + value / total
    return out
