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
    for index, op in enumerate(operations):
        if not isinstance(op, dict):
            raise ValueError(f"operation[{index}] must be an object")
        gate = op.get("gate")
        if not isinstance(gate, str) or not gate:
            raise ValueError(f"operation[{index}].gate must be a non-empty string")
        targets = op.get("targets")
        if not isinstance(targets, list) or not targets:
            raise ValueError(f"operation[{index}] ({gate}) requires a non-empty targets list")
        controls = op.get("controls", [])
        if gate == _MEASURE_GATE:
            if not barrier_inserted:
                circuit.barrier()  # 平台硬约束：测量前必须有 barrier 分隔读出窗口
                barrier_inserted = True
            circuit.measure(list(targets), list(range(len(targets))))
            continue
        if gate in _SINGLE_QUBIT_METHODS:
            if len(targets) != 1 or controls:
                raise ValueError(f"gate {gate} takes exactly 1 target and no controls")
            getattr(circuit, _SINGLE_QUBIT_METHODS[gate])(targets[0])
        elif gate in _ROTATION_GATES:
            if len(targets) != 1 or controls:
                raise ValueError(f"gate {gate} takes exactly 1 target and no controls")
            theta = op.get("theta")
            if isinstance(theta, bool) or not isinstance(theta, (int, float)):
                raise ValueError(f"gate {gate} requires a numeric 'theta'")
            getattr(circuit, _ROTATION_GATES[gate])(float(theta), targets[0])
        elif gate in _CONTROLLED_GATES:
            if len(controls) != 1 or len(targets) != 1:
                raise ValueError(f"gate {gate} takes exactly 1 control and 1 target")
            getattr(circuit, _CONTROLLED_GATES[gate])(controls[0], targets[0])
        else:
            raise ValueError(
                f"unsupported gate {gate!r} for logicalcloud submission; "
                f"supported: H/X/Y/Z/RX/RY/RZ/CX/CZ/MEASURE"
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
        circuit = circuit_to_lqcloud(circuit_json)
        backend = self._provider.get_backend(backend_name)
        return backend.run(circuit, shots=shots, readout_correction=True)

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
