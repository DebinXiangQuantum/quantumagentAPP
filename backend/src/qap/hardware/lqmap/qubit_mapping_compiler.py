"""噪声自适应量子编译模块（布局 + SWAP 路由）——为缺乏 transpile 能力的逻辑比特云平台补齐编译链。

学术依据（选型为该方向公认主线工作的组合）：

1. **噪声自适应初始映射**：Murali, Faruque, Margolus, Martonosi, Chong,
   "Noise-Adaptive Compiler Mappings for Noisy Intermediate-Scale Quantum
   Computers" (ASPLOS 2019)。按芯片标定挑选高质量连通子图并初始化布局。
   本模块实现其"标定驱动子图选择"思想：从质量最高的边出发，按边际质量贪心
   扩展出 K 比特连通子图。

2. **SABRE 布局与路由**：Li, Ding, Xie, "Tackling the Qubit Mapping Problem
   for NISQ-Era Quantum Devices" (ASPLOS 2019)。公认的实用最强启发式，
   Qiskit 的 SabreLayout/SabreSwap 即其参考实现。本模块把 SABRE 限制在
   选定的高质量子图上，并进行多种子搜索。

3. **保真度加权目标（"Not All SWAPs Have the Same Cost"）**：Patel et al.,
   arXiv:2205.10596（2022）指出在路由目标中注入边噪声信息优于单纯最小化
   SWAP 数；2024-25 趋势（EPAR、TRAM、QSteed 等）均转向 fidelity-driven。
   本模块对每个候选编译结果估计整线保真度
   F_est = Π_{两比特门∈边e} f_CZ(e) · Π_{单比特门∈q} f_XEB(q) · Π_{测量∈q} √(f0·f1)
   并择优（SWAP 按其 3 个两比特门等价电路计费 f_CZ^3）。

输入输出：
- 输入：Qiskit 逻辑线路 + 芯片标定（backend_configs.json 或 provider 实时配置）
- 输出：lqcloud.QuantumCircuit（物理比特索引直出，identity initial_layout）
  + 编译报告（选定物理比特、SWAP 数、估计保真度、与链式基线的对比）

已知简化（如实声明，不影响相对择优）：
- 未建模门时长与 T1/T2 退相干项（TRAM 式），仅用门保真度与读出保真度；
- SABRE 距离矩阵仍为拓扑跳数（未直接注入 -log f_CZ），噪声感知通过
  子图选择 + 候择优两层实现（ Patel et al. 证明两层化同样有效）。
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

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from qiskit import ClassicalRegister, QuantumCircuit, transpile

from .qiskit_to_lqcloud import LQ_BASIS_GATES, strip_and_remeasure


def _readout_quality(qubit: dict[str, Any]) -> float:
    f0 = float(qubit.get("measure_f0", 1.0))
    f1 = float(qubit.get("measure_f1", 1.0))
    return math.sqrt(max(f0, 0.0) * max(f1, 0.0))


class Calibration:
    """芯片标定：单比特质量（读出×XEB）、边质量（CZ×端点几何平均）。"""

    def __init__(self, backend_config: dict[str, Any]):
        self.name = backend_config.get("name", "?")
        self.num_qubits = int(backend_config.get("qubits", 0))
        props = backend_config.get("properties") or {}
        self.qubit_metrics: dict[int, dict[str, Any]] = {
            int(q["id"]): q for q in (props.get("qubit_metrics") or [])
        }
        self.topology_edges: list[tuple[int, int]] = [
            (int(a), int(b)) for a, b in (backend_config.get("topology") or {}).get("coupling_map") or []
        ]
        self.cz_fidelity: dict[tuple[int, int], float] = {}
        for entry in props.get("coupler_metrics") or []:
            pair = entry.get("qubits")
            if not pair or len(pair) != 2:
                continue
            key = (min(pair), max(pair))
            self.cz_fidelity[key] = float(entry.get("cz_fidelity", 0.0))

        # 邻接 + 边综合质量
        self.adjacency: dict[int, set[int]] = {}
        for a, b in self.topology_edges:
            self.adjacency.setdefault(a, set()).add(b)
            self.adjacency.setdefault(b, set()).add(a)

    @classmethod
    def from_file(cls, path: Path | str, backend_name: str) -> "Calibration":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(data[backend_name])

    def qubit_quality(self, q: int) -> float:
        """单比特综合质量：读出 √(f0·f1) × 单比特门 XEB。"""
        metrics = self.qubit_metrics.get(q, {})
        readout = _readout_quality(metrics)
        xeb = float(metrics.get("xeb_fidelity", 1.0))
        return readout * xeb

    def edge_cz(self, a: int, b: int) -> float:
        return self.cz_fidelity.get((min(a, b), max(a, b)), 0.0)

    def edge_quality(self, a: int, b: int) -> float:
        """边综合质量：CZ 保真度 × 两端单比特 XEB 几何平均（Patel 式边权重）。"""
        xa = float(self.qubit_metrics.get(a, {}).get("xeb_fidelity", 1.0))
        xb = float(self.qubit_metrics.get(b, {}).get("xeb_fidelity", 1.0))
        return self.edge_cz(a, b) * math.sqrt(xa * xb)

    def select_subgraph(self, size: int) -> list[int]:
        """噪声自适应连通子图（Murali et al. ASPLOS'19 的贪心变体）。

        从综合质量最高的边出发，每步并入使"新增边质量和 × 候选比特质量"
        最大的邻接比特，直到子图达到 size 个比特。
        """
        best_start = max(
            self.topology_edges,
            key=lambda e: self.edge_quality(*e) * math.sqrt(
                self.qubit_quality(e[0]) * self.qubit_quality(e[1])
            ),
        )
        chosen = {best_start[0], best_start[1]}
        while len(chosen) < size:
            candidates: list[tuple[float, int]] = []
            for node in chosen:
                for nxt in self.adjacency.get(node, ()):  # 与已选子图相连的比特
                    if nxt in chosen:
                        continue
                    # 边际分 = 新边质量 × 新比特质量（与所有已选邻居的边都要好才更优）
                    edges = [self.edge_quality(node, nxt) for node in chosen if nxt in self.adjacency.get(node, ())]
                    marginal = min(edges) * self.qubit_quality(nxt) if edges else 0.0
                    candidates.append((marginal, nxt))
            if not candidates:
                break
            _, node = max(candidates)
            chosen.add(node)
        return sorted(chosen)


@dataclass
class CompiledResult:
    """噪声自适应编译产物（字段兼容 qiskit_to_lqcloud.ConvertedCircuit）。"""

    lq_circuit: Any
    physical_qubits: list[int]
    transpiled_depth: int
    two_qubit_gates: int
    single_qubit_gates: int
    swaps: int
    estimated_fidelity: float
    seed: int
    subgraph: list[int] = field(default_factory=list)
    num_qubits_logical: int = 0
    num_clbits: int = 0
    measured_logical_qubits: list[int] = field(default_factory=list)

    @property
    def initial_layout(self) -> list[int]:
        """物理比特索引直出 → identity 映射。"""
        return list(range(self.width))

    @property
    def width(self) -> int:
        return (self.physical_qubits[-1] + 1) if self.physical_qubits else 1

    def summary(self) -> dict[str, Any]:
        return {
            "物理比特": self.physical_qubits,
            "子图": self.subgraph,
            "转译深度": self.transpiled_depth,
            "两比特门": self.two_qubit_gates,
            "SWAP": self.swaps,
            "估计保真度": round(self.estimated_fidelity, 4),
            "种子": self.seed,
        }


class NoiseAwareCompiler:
    """标定驱动的布局 + 路由编译器（子图选择 + SABRE + 保真度择优）。"""

    def __init__(self, calibration: Calibration, seed_base: int = 1):
        self.cal = calibration
        self.seed_base = seed_base

    # ------------------------------------------------------------------
    # 估计整线保真度（择优目标）
    # ------------------------------------------------------------------
    def estimate_fidelity(self, tq: QuantumCircuit) -> float:
        fidelity = 1.0
        for inst in tq.data:
            name = inst.operation.name
            qidx = [tq.find_bit(q).index for q in inst.qubits]
            if name == "barrier":
                continue
            if name == "measure":
                fidelity *= _readout_quality(self.cal.qubit_metrics.get(qidx[0], {}))
            elif name == "swap":
                a, b = qidx
                fidelity *= self.cal.edge_cz(a, b) ** 3  # SWAP ≈ 3 个两比特门
            elif len(qidx) == 2:
                a, b = qidx
                fidelity *= self.cal.edge_cz(a, b)
            elif len(qidx) == 1:
                fidelity *= float(self.cal.qubit_metrics.get(qidx[0], {}).get("xeb_fidelity", 1.0))
        return fidelity

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    def compile(
        self,
        circuit: QuantumCircuit,
        *,
        measure_qubits: list[int] | None = None,
        n_seeds: int = 8,
        subgraph_size: int | None = None,
        optimization_level: int = 1,
    ) -> CompiledResult:
        normalized, _measured = strip_and_remeasure(circuit, measure_qubits)
        size = subgraph_size or max(normalized.num_qubits + 2, 8)
        size = min(size, self.cal.num_qubits)
        subgraph = self.cal.select_subgraph(size)
        sub_edges = [
            [a, b]
            for a, b in self.cal.topology_edges
            if a in set(subgraph) and b in set(subgraph)
        ]
        if not sub_edges:
            raise ValueError("选定子图没有可用耦合边")

        best: tuple[float, QuantumCircuit, int] | None = None
        for offset in range(n_seeds):
            seed = self.seed_base + offset
            tq = transpile(
                normalized,
                basis_gates=LQ_BASIS_GATES,
                coupling_map=sub_edges,
                optimization_level=optimization_level,
                seed_transpiler=seed,
                layout_method="sabre",
                routing_method="sabre",
            )
            score = self.estimate_fidelity(tq)
            if best is None or score > best[0]:
                best = (score, tq, seed)
        assert best is not None
        score, tq, seed = best

        from lqcloud import QuantumCircuit as LQCircuit

        used = sorted(
            {
                tq.find_bit(q).index
                for inst in tq.data
                if inst.operation.name not in ("barrier",)
                for q in inst.qubits
            }
        )
        width = (used[-1] + 1) if used else 1
        lq = LQCircuit(width, tq.num_clbits)
        twoq = single = swaps = 0
        for inst in tq.data:
            name = inst.operation.name
            if name == "barrier":
                lq.barrier()
                continue
            qidx = [tq.find_bit(q).index for q in inst.qubits]
            if name == "measure":
                lq.measure(qidx[0], tq.find_bit(inst.clbits[0]).index)
            elif name in {"cx", "cnot"}:
                lq.cx(qidx[0], qidx[1]); twoq += 1
            elif name == "cz":
                lq.cz(qidx[0], qidx[1]); twoq += 1
            elif name == "swap":
                lq.swap(qidx[0], qidx[1]); twoq += 1; swaps += 1
            elif name == "cy":
                lq.cy(qidx[0], qidx[1]); twoq += 1
            elif name in {"id", "h", "x", "y", "z", "s", "sdg", "t", "tdg", "sx", "sxdg"}:
                getattr(lq, name)(qidx[0]); single += 1
            elif name in {"rx", "ry", "rz", "p"}:
                (theta,) = [float(p) for p in inst.operation.params]
                getattr(lq, name)(theta, qidx[0]); single += 1
            elif name == "u":
                theta, phi, lam = [float(p) for p in inst.operation.params]
                lq.u(theta, phi, lam, qidx[0]); single += 1
            else:
                raise ValueError(f"转译后仍出现不支持的指令：{name}")

        return CompiledResult(
            lq_circuit=lq,
            physical_qubits=used,
            transpiled_depth=int(tq.depth()),
            two_qubit_gates=twoq,
            single_qubit_gates=single,
            swaps=swaps,
            estimated_fidelity=score,
            seed=seed,
            subgraph=subgraph,
            num_qubits_logical=normalized.num_qubits,
            num_clbits=int(tq.num_clbits),
            measured_logical_qubits=_measured,
        )

    # ------------------------------------------------------------------
    # 与"链式嵌入基线"（套件旧方法）对比
    # ------------------------------------------------------------------
    def compare_with_chain_baseline(
        self,
        circuit: QuantumCircuit,
        *,
        measure_qubits: list[int] | None = None,
        n_seeds: int = 8,
    ) -> dict[str, Any]:
        from qiskit import QuantumCircuit as QC
        from .qiskit_to_lqcloud import convert

        chain_result = convert(
            circuit,
            self.cal.topology_edges,
            measure_qubits=measure_qubits,
            optimization_level=1,
        )
        # 基线估计保真度：按其 initial_layout 把压缩索引映射回物理比特后估计
        baseline_layout = chain_result.initial_layout
        width = max(baseline_layout) + 1 if baseline_layout else 1
        mapped = QC(width, chain_result.num_clbits)
        for gate, qubits, clbits in chain_result.lq_circuit.data:
            name = gate.name.lower()
            qidx = [q.index for q in qubits]
            if name == "barrier":
                mapped.barrier()
            elif name == "measure":
                mapped.measure(baseline_layout[qidx[0]], clbits[0].index)
            elif name in {"cx", "cnot"}:
                mapped.cx(baseline_layout[qidx[0]], baseline_layout[qidx[1]])
            elif name == "cz":
                mapped.cz(baseline_layout[qidx[0]], baseline_layout[qidx[1]])
            elif name == "swap":
                mapped.swap(baseline_layout[qidx[0]], baseline_layout[qidx[1]])
            elif name == "cy":
                mapped.cy(baseline_layout[qidx[0]], baseline_layout[qidx[1]])
            elif name in {"id", "h", "x", "y", "z", "s", "sdg", "t", "tdg", "sx", "sxdg"}:
                getattr(mapped, name)(baseline_layout[qidx[0]])
            elif name in {"rx", "ry", "rz", "p"}:
                getattr(mapped, name)(float(gate.params[0]), baseline_layout[qidx[0]])
            elif name == "u":
                theta, phi, lam = [float(p) for p in gate.params]
                mapped.u(theta, phi, lam, baseline_layout[qidx[0]])
            else:
                raise ValueError(f"基线线路含未知指令：{name}")
        baseline_fid = self.estimate_fidelity(mapped)

        nm = self.compile(circuit, measure_qubits=measure_qubits, n_seeds=n_seeds)
        return {
            "链式基线": {
                "物理映射": baseline_layout,
                "两比特门": chain_result.two_qubit_gates,
                "SWAP": chain_result.swaps,
                "估计保真度": round(baseline_fid, 4),
            },
            "噪声自适应": {
                "物理映射": nm.physical_qubits,
                "两比特门": nm.two_qubit_gates,
                "SWAP": nm.swaps,
                "估计保真度": round(nm.estimated_fidelity, 4),
                "子图": nm.subgraph,
                "种子": nm.seed,
            },
            "估计保真度提升(×)": round(nm.estimated_fidelity / baseline_fid, 3) if baseline_fid > 0 else None,
        }


# ---------------------------------------------------------------------------
# 离线基准：对一组线路输出 基线 vs 噪声自适应 的估计保真度对比表
# ---------------------------------------------------------------------------

def benchmark(circuits: dict[str, QuantumCircuit], calibration: Calibration, **compile_kwargs) -> list[dict[str, Any]]:
    compiler = NoiseAwareCompiler(calibration)
    rows = []
    for name, circuit in circuits.items():
        try:
            comparison = compiler.compare_with_chain_baseline(circuit, **compile_kwargs)
            rows.append({"name": name, **comparison})
        except Exception as exc:  # noqa: BLE001
            rows.append({"name": name, "error": f"{type(exc).__name__}: {exc}"})
    return rows
