"""步骤执行器：**真实计算负载 + 真实测量**（契约 §4 v1.3，measured）。

**语义声明（与契约一致）**：本模块执行的负载与测得的 ``duration_ms``/
``peak_memory_mb`` 是**真实执行的真实测量值（measured），不是编造数字，
也不是硬件观测**——负载是进程内的纯 Python 计算，测量使用标准库
``time.perf_counter``（墙钟）与 ``tracemalloc``（Python 堆峰值）；
文档与 UI 不得将其表述为 QPU/GPU/CPU 硬件指标。

负载族谱（按 kind）：
- quantum：纯 Python 态矢量模拟——按步规格 ``workload.qubits``（缺省 8，
  上界 16 防原型内存失控）构造 ``2^n`` 复幅度列表，逐门迭代（每层对全部
  qubit 作用 Hadamard + CNOT 链），末了校验范数守恒（|‖ψ‖²−1|）；
- classical：JSON 序列化 → zlib 压缩 → 解压 → 反序列化回环（负载字节数
  ``workload.bytes``，缺省 256KB），校验记录数守恒；
- agent（未绑定子运行执行器的单元测试路径）：与 classical 同族的真实
  压缩负载；生产路径由组装根注入 dispatch 子运行执行器（api/state.py，
  时长为子运行真实总时长、内存不可得 → null）。

接缝保持：Scheduler 注入自定义 runner 可完全接管（超时负样本测试用
``never_finish_step``）。
"""

from __future__ import annotations

import asyncio
import json
import math
import tracemalloc
import zlib
from collections.abc import Callable
from typing import TypeVar

from qap.domain.models import Step

#: quantum 步缺省/上界 qubit 数（2^16 幅度 ≈ 数 MB Python 对象，原型上限）
DEFAULT_QUBITS = 8
MAX_QUBITS = 16
#: classical 步缺省/上界负载字节数（256KB；上界 8MB 与附件限额一致）
DEFAULT_PAYLOAD_BYTES = 256 * 1024
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
#: 低于该值的峰值内存（字节）在 1 位小数 MB 精度下不可表示 → null
_MEMORY_PRECISION_FLOOR_BYTES = int(0.05 * 1024 * 1024)

T = TypeVar("T")


def _workload_int(step: Step, key: str, default: int, maximum: int) -> int:
    """从步规格读取整型参数；缺失/畸形/越界回退默认并夹取上界。"""
    raw = (step.workload or {}).get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    if value < 1:
        value = default
    return min(value, maximum)


def _measure_peak_bytes(work: Callable[[], T]) -> tuple[T, int | None]:
    """在 tracemalloc 追踪下执行 ``work``，返回 (结果, 峰值字节数)。

    - 测量块是**纯同步**的（无 await）——asyncio 单线程下其它协程不会
      在测量期间交错，读数即本负载自己的峰值（并发步互不污染）；
    - 若外部已开启 tracemalloc（如调试器），不自作主张停止它，改以
      前后 current 差近似（无真峰值 → 可能低估；此路径仅诊断场景）；
    - 峰值低于 0.05MB 时在 1 位小数 MB 精度下不可表示 → 返回 None
      （契约 §4："peak_memory_mb > 0 或 null"）。
    """
    external_tracing = tracemalloc.is_tracing()
    if external_tracing:
        baseline = tracemalloc.get_traced_memory()[0]
        result = work()
        delta = tracemalloc.get_traced_memory()[0] - baseline
        return result, (delta if delta >= _MEMORY_PRECISION_FLOOR_BYTES else None)
    tracemalloc.start()
    try:
        result = work()
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    return result, (peak if peak >= _MEMORY_PRECISION_FLOOR_BYTES else None)


def _set_peak_memory(step: Step, peak_bytes: int | None) -> None:
    """把测得峰值写入 step.peak_memory_mb（MB、1 位小数；<0.05MB → null）。"""
    if peak_bytes is None:
        step.peak_memory_mb = None
        return
    megabytes = round(peak_bytes / (1024 * 1024), 1)
    # round 后可能为 0.0（<0.05MB）：精度下不可表示，按契约记 null。
    step.peak_memory_mb = megabytes if megabytes > 0 else None


def _run_quantum_workload(step: Step, qubits: int) -> str:
    """纯 Python 态矢量模拟（measured）；返回人类可读执行说明。"""
    gates_applied = 0

    def simulate() -> float:
        """返回 |‖ψ‖² − 1|（范数守恒偏差，模拟正确性的可观察输出）。"""
        nonlocal gates_applied
        size = 1 << qubits
        # 初态 |0…0⟩：幅度列表即态矢量（纯 Python complex，无 numpy）
        state: list[complex] = [0j] * size
        state[0] = 1.0 + 0.0j
        inv_sqrt2 = 1.0 / math.sqrt(2.0)
        for layer in range(2):  # 两层（H 全体 + CNOT 链）足以摊平负载
            for q in range(qubits):  # Hadamard：成对旋转 (|0⟩±|1⟩)/√2
                bit = 1 << q
                for i in range(size):
                    if i & bit:
                        continue
                    j = i | bit
                    a, b = state[i], state[j]
                    state[i] = (a + b) * inv_sqrt2
                    state[j] = (a - b) * inv_sqrt2
                    gates_applied += 1
            for control in range(qubits - 1):  # CNOT 链：|c⟩ 控制 t=c+1
                target = control + 1
                cbit, tbit = 1 << control, 1 << target
                for i in range(size):
                    if i & cbit and not i & tbit:
                        j = i | tbit
                        state[i], state[j] = state[j], state[i]
                        gates_applied += 1
        norm = sum(abs(amplitude) ** 2 for amplitude in state)
        return abs(norm - 1.0)

    deviation, peak_bytes = _measure_peak_bytes(simulate)
    _set_peak_memory(step, peak_bytes)
    peak = "null" if step.peak_memory_mb is None else f"{step.peak_memory_mb}MB"
    return (
        f"quantum statevector simulation (measured): {qubits} qubits, "
        f"{gates_applied} gate applications, |norm^2-1|={deviation:.2e}, "
        f"peak_memory={peak}"
    )


def _run_classical_workload(step: Step, payload_bytes: int) -> str:
    """JSON 生成 → zlib 压缩 → 解压 → 反序列化回环（measured）。"""
    record_count = max(1, payload_bytes // 128)  # 每条记录约 128B JSON

    def roundtrip() -> tuple[int, int]:
        records = [
            {"id": i, "payload": "x" * 96, "weight": i * 0.25}
            for i in range(record_count)
        ]
        document = json.dumps({"records": records}, ensure_ascii=False)
        compressed = zlib.compress(document.encode("utf-8"), level=6)
        decompressed = zlib.decompress(compressed).decode("utf-8")
        parsed = json.loads(decompressed)
        if len(parsed["records"]) != record_count:  # pragma: no cover - 守恒防御
            raise RuntimeError("classical workload roundtrip lost records")
        return len(document), len(compressed)

    (raw_size, compressed_size), peak_bytes = _measure_peak_bytes(
        lambda: roundtrip()
    )
    _set_peak_memory(step, peak_bytes)
    peak = "null" if step.peak_memory_mb is None else f"{step.peak_memory_mb}MB"
    return (
        f"classical JSON zlib roundtrip (measured): {record_count} records, "
        f"{raw_size}B -> {compressed_size}B compressed, "
        f"peak_memory={peak}"
    )


async def simulate_step(step: Step) -> str:
    """执行一个步骤的**真实计算负载**并实测 profile（measured）。

    - quantum/classical：同步计算块内以 tracemalloc 量峰值内存并写入
      ``step.peak_memory_mb``；``duration_ms`` 由调度器统一以 perf_counter
      计（覆盖执行全程，满足不变量 5 的 ±50ms 一致性）；
    - agent：未绑定子运行执行器时的回退路径（单元测试）——执行 classical
      族负载；生产路径的 dispatch 子运行见 Scheduler 的 agent executor。
    - 失败行为：永不主动失败（超时/无节点由调度器判定）；取消由 asyncio
      任务取消语义传播（CancelledError 原样上抛）。
    """
    import asyncio

    await asyncio.sleep(0)  # 让出一次控制权：测量块保持纯同步（见 docstring）
    if step.kind == "quantum":
        qubits = _workload_int(step, "qubits", DEFAULT_QUBITS, MAX_QUBITS)
        return _run_quantum_workload(step, qubits)
    if step.kind == "classical":
        payload_bytes = _workload_int(
            step, "bytes", DEFAULT_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES
        )
        return _run_classical_workload(step, payload_bytes)
    # agent：无子运行执行器时的真实负载回退（单元测试路径）
    payload_bytes = _workload_int(
        step, "bytes", DEFAULT_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES
    )
    return _run_classical_workload(step, payload_bytes)


async def never_finish_step(step: Step) -> str:
    """永不完成的执行器（负样本测试：步骤超时路径专用）。"""
    import asyncio

    await asyncio.Event().wait()  # 永远阻塞，直到被取消
    raise AssertionError("unreachable")  # pragma: no cover
