"""logicalcloud（LQCloud）适配层：契约 §3 v1.4 / §9 v1.4 的真机薄封装。

**数据性质声明**：经本模块取得的一切后端/任务/计数均为 **cloud-observed**
（云端真机观测），与 simulated（本地模拟）/ measured（本地实测负载）严格
区分；文档、事件与 UI 消费方不得混淆。

模块三件事：
1. :func:`circuit_to_lqcloud`——契约 §6 circuit JSON（{qubits, operations[]}）
   → ``lqcloud.QuantumCircuit``。支持门 H/X/Y/Z/RX/RY/RZ(theta)/CX/CZ
   （CNOT 为 CX 别名，对齐 §6 演示线路用名）；**首个 MEASURE 前自动插入
   barrier**（平台实测硬约束：无 barrier 分隔读出窗口的提交即 CircuitError）；
   未知门/畸形操作 → :class:`ValueError`（诚实拒绝，绝不静默跳过）。
2. :class:`LqCloudAdapter`——provider 对象（duck-typed，测试注入
   FakeCloudProvider，生产注入 ``lqcloud.LQCloudProvider``）的四个动作：
   ``list_backends``（→ 规范 dict）、``submit``（→ job 句柄）、
   ``poll``（→ {status, queue_position}）、``result_counts``（→ counts dict）。
   方法为薄封装：不吞服务端异常（CircuitError/JobError 等原样上抛，
   由调用方转 step.error 或启动 fail-fast）。
3. 序列化助手 :func:`serialize_instructions`——供测试断言"提交产物含
   barrier"（与 lqcloud 序列化同源）。

依赖为可选 extra：``pip install -e ".[hardware]"``（lqcloud==0.5.1）；
未安装时首次使用给出可操作的 ImportError（配置校验层不 import 本模块的
类即可在不装 extra 的环境运行 simulated 模式）。
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

#: lqcloud==0.5.1（契约 §9 v1.4 固定版本；API 面经本仓库测试复核）
LQCLOUD_REQUIREMENT = "lqcloud==0.5.1"


def _require_lqcloud():
    """惰性导入 lqcloud；缺失时给出可操作的安装指引。"""
    try:
        import lqcloud  # noqa: F401 - 仅探测
    except ImportError as exc:  # pragma: no cover - 依赖缺失路径
        raise ImportError(
            "lqcloud is required for the logicalcloud hardware provider; "
            f'install with: pip install -e ".[hardware]" ({LQCLOUD_REQUIREMENT})'
        ) from exc
    from lqcloud import QuantumCircuit

    return QuantumCircuit


#: 单量子门 → QuantumCircuit 方法名（RX/RY/RZ 需 theta，单独处理）
_SINGLE_QUBIT_METHODS = {
    "H": "h",
    "X": "x",
    "Y": "y",
    "Z": "z",
}
#: 旋转门（theta 参数）
_ROTATION_GATES = {"RX": "rx", "RY": "ry", "RZ": "rz"}
#: 受控两比特门（CX/CZ；CNOT 为 CX 的契约别名）
_CONTROLLED_GATES = {"CX": "cx", "CNOT": "cx", "CZ": "cz"}
#: 测量伪门（§6）
_MEASURE_GATE = "MEASURE"
#: v1.5 双比特 ZZ 旋转门（分解 CX·RZ·CX）
_RZZ_GATE = "RZZ"


def _rotation_angle(op: dict[str, Any]) -> float:
    """旋转角度双轨解析（§6 v1.5）：params[0]（正式）优先，旧 theta 兼容。

    :raises ValueError: 缺角度 / 非数值 / 非有限（NaN/Inf 一律拒绝）。
    """
    params = op.get("params")
    raw = params[0] if isinstance(params, list) and params else op.get("theta")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(
            f"gate {op.get('gate')!r} requires a numeric angle (params[0] or theta)"
        )
    angle = float(raw)
    if angle != angle or angle in (float("inf"), float("-inf")):
        raise ValueError(f"gate {op.get('gate')!r} angle must be finite, got {raw!r}")
    return angle


def circuit_to_lqcloud(circuit_json: dict[str, Any]):
    """契约 §6 circuit JSON → ``lqcloud.QuantumCircuit``。

    - 逐操作按声明次序发射；首个 MEASURE 前自动 ``qc.barrier()``（全比特，
      平台硬约束，见模块 docstring）；
    - MEASURE 把 targets 顺序映射到经典比特 0..k-1（读出次序即键序）；
    - 未知 gate 名 / 缺 targets / 非法 theta → :class:`ValueError`。

    :param circuit_json: ``{"qubits": int, "operations": [...]}``（载荷校验
        已由 Artifact 生成侧完成；本函数独立复核形状——不信任调用方）。
    """
    QuantumCircuit = _require_lqcloud()
    if not isinstance(circuit_json, dict):
        raise ValueError("circuit payload must be a JSON object")
    qubits = circuit_json.get("qubits")
    if not isinstance(qubits, int) or isinstance(qubits, bool) or qubits < 1:
        raise ValueError(f"circuit.qubits must be a positive int, got {qubits!r}")
    operations = circuit_json.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("circuit.operations must be a non-empty list")
    circuit = QuantumCircuit(qubits, qubits)
    barrier_inserted = False
    measured: set[int] = set()  # v1.5 测量后守卫状态
    for index, op in enumerate(operations):
        if not isinstance(op, dict):
            raise ValueError(f"operation[{index}] must be an object")
        raw_gate = op.get("gate")
        if not isinstance(raw_gate, str) or not raw_gate.strip():
            raise ValueError(f"operation[{index}].gate must be a non-empty string")
        # 门名大小写归一（实测 GLM 产出 "h"/"cx" 小写变体；§6 演示为大写）：
        # 已知门的大小写变体不是未知门，未知门仍 ValueError（诚实拒绝）。
        gate = raw_gate.strip().upper()
        targets = op.get("targets")
        if not isinstance(targets, list) or not targets:
            raise ValueError(f"operation[{index}] ({gate}) requires a non-empty targets list")
        controls = op.get("controls", [])
        if gate == _MEASURE_GATE:
            if not barrier_inserted:
                circuit.barrier()  # 平台硬约束：测量前必须有 barrier 分隔读出窗口
                barrier_inserted = True
            circuit.measure(list(targets), list(range(len(targets))))
            measured.update(int(q) for q in targets)
            continue
        # v1.5 测量后守卫（§6 不变量的提交侧兜底）：已测量比特不得再被作用
        touched = {int(q) for q in targets} | {int(q) for q in controls}
        if touched & measured:
            raise ValueError(
                f"operation[{index}] ({gate}) acts on a qubit already measured; "
                f"no operations may follow a qubit's MEASURE"
            )
        if gate in _SINGLE_QUBIT_METHODS:
            if len(targets) != 1 or controls:
                raise ValueError(f"gate {gate} takes exactly 1 target and no controls")
            getattr(circuit, _SINGLE_QUBIT_METHODS[gate])(targets[0])
        elif gate == _RZZ_GATE:
            # RZZ(θ) ≡ CX(a,b)·RZ(θ,b)·CX(a,b)（Qiskit RZZGate 等价定义）
            if len(targets) != 2 or controls:
                raise ValueError("RZZ takes exactly 2 targets and no controls")
            a, b = int(targets[0]), int(targets[1])
            theta = _rotation_angle(op)
            circuit.cx(a, b)
            circuit.rz(theta, b)
            circuit.cx(a, b)
        elif gate in _ROTATION_GATES:
            if len(targets) != 1 or controls:
                raise ValueError(f"gate {gate} takes exactly 1 target and no controls")
            theta = _rotation_angle(op)
            getattr(circuit, _ROTATION_GATES[gate])(theta, targets[0])
        elif gate in _CONTROLLED_GATES:
            if len(controls) != 1 or len(targets) != 1:
                raise ValueError(f"gate {gate} takes exactly 1 control and 1 target")
            getattr(circuit, _CONTROLLED_GATES[gate])(controls[0], targets[0])
        else:
            raise ValueError(
                f"unsupported gate {gate!r} for logicalcloud submission; "
                f"supported: H/X/Y/Z/RX/RY/RZ/CX/CZ/RZZ/MEASURE"
            )
    return circuit


def serialize_instructions(circuit) -> list[dict[str, Any]]:
    """线路 → lqcloud 序列化指令列表（测试断言 barrier/门名的同源视图）。"""
    from lqcloud.backend.serialization import serialize_circuit

    return list(serialize_circuit(circuit).get("instructions", []))


@runtime_checkable
class CloudProviderLike(Protocol):
    """适配层消费的 provider 最小面（LQCloudProvider 与 FakeCloudProvider 均满足）。"""

    def get_backends(self) -> list: ...

    def get_backend(self, name: str) -> Any: ...


class LqCloudAdapter:
    """lqcloud provider 的薄封装（构造注入，绝不自发网络）。

    - ``list_backends()``：``get_backends()`` 原始记录 → 规范 dict
      ``{name, chip_architecture, status, qubits, topology}``（缺字段的
      键以 None/空 dict 降级——云端字段演进时前端可降级渲染）；
    - ``submit(circuit_json, shots, backend_name)``：转换线路 →
      ``backend.run(circuit, shots, readout_correction=True)``（契约 §9
      v1.4 固定开启读出修正）→ 返回 job 句柄；
    - ``poll(job)``：单次轮询 ``{"status": str, "queue_position": int|None}``
      （queued/pending 之外的位置信息云端不保证 → None）；
    - ``result_counts(job)``：``job.result(verbose=False)`` →
      ``result.get_counts()``（键去掉空格分隔符，值为 int）。
    """

    def __init__(self, provider: CloudProviderLike) -> None:
        if provider is None:
            raise ValueError("LqCloudAdapter requires a provider instance")
        self._provider = provider
        #: 最近一次 submit 的编译报告（lqmap 路由产物；直构回退时为 None）。
        #: runner 读取后并入 step.detail（物理比特/SWAP 数/估计保真度）。
        self.last_compile_report: dict[str, Any] | None = None

    # ---------- 后端发现 ----------

    def list_backends(self) -> list[dict[str, Any]]:
        """拉取真机列表（cloud-observed）；云端异常原样上抛。"""
        backends = self._provider.get_backends()
        if not isinstance(backends, list):
            raise ValueError(
                f"get_backends() must return a list, got {type(backends).__name__}"
            )
        return [_normalize_backend(raw) for raw in backends]

    # ---------- 任务生命周期 ----------

    def submit(self, circuit_json: dict[str, Any], shots: int, backend_name: str):
        """转换并提交线路（服务端 CircuitError 等原样上抛）。"""
        if not isinstance(shots, int) or isinstance(shots, bool) or shots < 1:
            raise ValueError(f"shots must be a positive int, got {shots!r}")
        if not isinstance(backend_name, str) or not backend_name.strip():
            raise ValueError("backend_name must be a non-empty string")
        self.last_compile_report = None
        circuit = self._compile_routed(circuit_json, backend_name)
        backend = self._provider.get_backend(backend_name)
        return backend.run(circuit, shots=shots, readout_correction=True)

    def _compile_routed(self, circuit_json: dict[str, Any], backend_name: str):
        """噪声自适应编译（迁入模块 lqmap）：逻辑线路 → 耦合图路由线路。

        qiskit/lqmap 可用时：构建 qiskit 线路 → Calibration（后端拓扑，
        云端无标定时按拓扑均匀质量降级）→ SABRE 多种子择优 → lqcloud
        线路（物理比特直出、SWAP 已插入），报告存 last_compile_report。
        不可用/编译异常 → 回退 v1.4 直构路径（报告 None，行为不变）。
        """
        if not _lqmap_available():
            return circuit_to_lqcloud(circuit_json)
        try:
            from qap.hardware.lqmap import Calibration, NoiseAwareCompiler

            raw = next(
                (
                    b
                    for b in self._provider.get_backends()
                    if isinstance(b, dict) and str(b.get("name")) == backend_name
                ),
                None,
            )
            if raw is None:
                return circuit_to_lqcloud(circuit_json)
            compiled = NoiseAwareCompiler(Calibration(raw)).compile(
                _to_qiskit_circuit(circuit_json)
            )
            self.last_compile_report = {
                "physical_qubits": list(compiled.physical_qubits),
                "swaps": int(compiled.swaps),
                "two_qubit_gates": int(compiled.two_qubit_gates),
                "transpiled_depth": int(compiled.transpiled_depth),
                "estimated_fidelity": round(float(compiled.estimated_fidelity), 4),
            }
            return compiled.lq_circuit
        except Exception:
            # 编译失败（如云端拓扑形状超出预期）→ 诚实回退直构，由平台
            # 序列化校验给出具体错误（不吞掉根因）
            self.last_compile_report = None
            return circuit_to_lqcloud(circuit_json)

    def poll(self, job) -> dict[str, Any]:
        """单次轮询：``{"status", "queue_position"}``（cloud-observed）。"""
        info = job.status_info()
        status = str(info.get("status") or "")
        position = info.get("queue_position")
        if position is not None:
            try:
                position = int(position)
            except (TypeError, ValueError):
                position = None
        return {"status": status, "queue_position": position}

    def result_counts(self, job) -> dict[str, int]:
        """取真实计数（cloud-observed）；失败任务抛 SDK 的 JobError。"""
        result = job.result(verbose=False)
        counts = result.get_counts()
        normalized: dict[str, int] = {}
        for key, value in counts.items():
            clean_key = str(key).replace(" ", "")
            normalized[clean_key] = int(value)
        return normalized


def _lqmap_available() -> bool:
    """qiskit + lqmap 可用性探测（backend 可选 extra [hardware]）。"""
    try:
        import qiskit  # noqa: F401

        from qap.hardware.lqmap import Calibration, NoiseAwareCompiler  # noqa: F401

        return True
    except Exception:  # ImportError 及迁移模块自身异常都回退直构
        return False


def _to_qiskit_circuit(circuit_json: dict[str, Any]):
    """契约 §6 电路 JSON → qiskit QuantumCircuit（lqmap 编译入口用）。

    与 circuit_to_lqcloud 同一门集与角度双轨；qiskit 原生含 RZZGate，
    无需分解（编译器会在基组/basis 约束下自行处理）。
    """
    from qiskit import QuantumCircuit as QC

    qubits = int(circuit_json["qubits"])
    qc = QC(qubits, qubits)
    for op in circuit_json["operations"]:
        gate = str(op["gate"]).strip().upper()
        targets = [int(q) for q in op["targets"]]
        controls = [int(q) for q in (op.get("controls") or [])]
        if gate == "MEASURE":
            for i, q in enumerate(targets):
                qc.measure(q, i)
            continue
        if gate in ("RX", "RY", "RZ"):
            getattr(qc, gate.lower())(_rotation_angle(op), targets[0])
        elif gate == "RZZ":
            qc.rzz(_rotation_angle(op), targets[0], targets[1])
        elif gate in ("CNOT", "CX"):
            qc.cx(controls[0], targets[0])
        elif gate == "CY":
            qc.cy(controls[0], targets[0])
        elif gate == "CZ":
            qc.cz(controls[0], targets[0])
        elif gate == "H":
            qc.h(targets[0])
        elif gate == "X":
            qc.x(targets[0])
        elif gate == "Y":
            qc.y(targets[0])
        elif gate == "Z":
            qc.z(targets[0])
        else:
            raise ValueError(f"unsupported gate {gate!r} for routing compile")
    return qc


def _normalize_backend(raw: Any) -> dict[str, Any]:
    """云端原始记录 → 规范 dict（缺字段降级，不猜测）。

    实测（2026-10-14 冒烟）：``topology`` 含 ``rows``/``cols`` 与
    ``qubit_coordinates``（**dict**，键为比特下标字符串、值为 [x,y]）及
    ``coupling_map``（[a,b] 对列表，无保真度值）——均原样透传（cloud-
    observed），由注册表侧构建节点拓扑。
    """
    if not isinstance(raw, dict):
        raise ValueError(f"backend record must be an object, got {type(raw).__name__}")
    topology = raw.get("topology")
    if not isinstance(topology, dict):
        topology = {}
    # v1.7 标定采集（实测 2026-10-14）：properties 含 last_update 与
    # qubit_metrics（measure_f0/f1、t1/t2/t2_star µs、xeb_fidelity）、
    # coupler_metrics（cz_fidelity）——cloud-observed 原样透传给注册表映射
    properties = raw.get("properties")
    if not isinstance(properties, dict):
        properties = {}
    return {
        "name": raw.get("name"),
        "chip_architecture": raw.get("chip_architecture"),
        "status": raw.get("status"),
        "qubits": raw.get("qubits"),
        "topology": {
            "rows": topology.get("rows"),
            "cols": topology.get("cols"),
            "qubit_coordinates": topology.get("qubit_coordinates") or {},
            "coupling_map": topology.get("coupling_map") or [],
        },
        "properties": {
            "last_update": properties.get("last_update"),
            "qubit_metrics": properties.get("qubit_metrics") or [],
            "coupler_metrics": properties.get("coupler_metrics") or [],
        },
    }


#: 云端节点 id 前缀（注册表区分云拉节点与 config 手写模拟节点）
CLOUD_NODE_ID_PREFIX = "lq-"


def cloud_node_id(backend_name: str) -> str:
    """真机名 → 注册表节点 id（``lq-<name>``）。"""
    return f"{CLOUD_NODE_ID_PREFIX}{backend_name}"


def backend_name_of(node_id: str) -> str | None:
    """注册表节点 id → 真机名（非 ``lq-`` 前缀返回 None）。"""
    if node_id.startswith(CLOUD_NODE_ID_PREFIX):
        return node_id[len(CLOUD_NODE_ID_PREFIX):]
    return None
