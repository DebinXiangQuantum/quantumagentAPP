"""硬件节点注册表：config 手写节点 + logicalcloud 实拉真机（契约 §3 v1.4）。

- 注册表持有**权威** :class:`HardwareNode` 实例（含活动租约、利用率与
  metrics）；对外一律通过 :meth:`snapshot` 给出深拷贝，避免调用方
  误改内部状态（分配器/模拟器是仅有的两个内部协作者）。
- 所有变更都过模型校验（utilization 有限且 ∈ [0,1]，容量 ≥ 1），
  非法值立即抛 ``ValidationError``——不变量 3 的第一道防线。
- **provider 模式（v1.4）**：``simulated``（缺省）= 全部节点来自 config
  手写 ``[[hardware.nodes]]``（metrics 为 simulated，由 metrics.py 生成）；
  ``logicalcloud`` = QPU 节点启动时经 :class:`LqCloudAdapter` 实拉
  （id ``lq-<name>``，metrics.topology 来自云端 qubit_coordinates，
  **cloud-observed**：fidelity 字段全 null——平台未提供，绝不伪造），
  config 手写 qpu 条目被忽略、GPU/CPU 模拟节点保留。拉取失败/密钥缺失
  → :class:`ConfigError`（启动 fail-fast，带原因）。
- 模拟器只作用于 ``simulated_ids()``（手写节点）；云拉节点的利用率无
  云端数据 → 恒 0 不漂移（诚实降级，见 simulator.py）。
"""

from __future__ import annotations

import copy
import os
import random
from typing import TYPE_CHECKING, Any, Sequence

from qap.core.config import ConfigError, HardwareConfig
from qap.domain.models import HardwareNode, NodeStatus
from qap.hardware.metrics import build_initial_metrics

if TYPE_CHECKING:  # 仅为类型注解（避免无 lqcloud 环境的硬依赖）
    from qap.hardware.lqcloud_adapter import LqCloudAdapter


def build_cloud_nodes(backends: Sequence[dict[str, Any]]) -> list[HardwareNode]:
    """云端后端记录（适配器规范 dict）→ QPU :class:`HardwareNode` 列表。

    字段映射（契约 §3 v1.4，全部 **cloud-observed**）：
    - ``id = "lq-<name>"``；``model = chip_architecture``；
    - ``status``：active → online，其余（offline/未知）→ offline；
    - ``capacity = 1``（单任务串行；平台按任务粒度独占）；
    - ``metrics``：拓扑用云端 ``topology.qubit_coordinates`` 摆放比特点——
      rows/cols 取坐标极值 + 1，qubit id = 坐标列表下标（含 x/y 原坐标），
      ``couplers = []`` 与全部 fidelity 字段 = null（平台未提供，
      **诚实为空**，前端降级）；``source = "cloud-observed"`` 标注数据
      性质，供 invariants 的云分支与前端区分；
    - 无 name 的记录跳过（防御性；云端契约 name 必在）。
    """
    from qap.hardware.lqcloud_adapter import cloud_node_id

    nodes: list[HardwareNode] = []
    for raw in backends:
        name = raw.get("name")
        if not isinstance(name, str) or not name.strip():
            continue  # 无名记录无法寻址：跳过（不猜测）
        status: NodeStatus = (
            "online" if str(raw.get("status", "")).strip().lower() == "active" else "offline"
        )
        nodes.append(
            HardwareNode(
                id=cloud_node_id(name),
                kind="qpu",
                name=name,
                model=str(raw.get("chip_architecture") or "unknown"),
                capacity=1,
                status=status,
                metrics=_cloud_qpu_metrics(raw),
            )
        )
    return nodes


def _cloud_qpu_metrics(raw: dict[str, Any]) -> dict[str, Any]:
    """云端记录 → QPU metrics（cloud-observed 拓扑 + v1.7 标定映射）。

    properties.qubit_metrics/coupler_metrics 存在时映射保真度/T1/T2
    （readout=√(f0·f1)、sq=xeb、tq=cz；缺项 null 诚实降级）。
    """
    topology = raw.get("topology") or {}
    raw_coordinates = topology.get("qubit_coordinates") or {}
    # dict（实测形状：键=比特下标字符串 → [x,y]）与 list（兼容形状）统一
    # 为 (id, coordinate) 流，按 id 排序保序
    items: list[tuple[int, Any]]
    if isinstance(raw_coordinates, dict):
        items = []
        for key, value in raw_coordinates.items():
            try:
                items.append((int(key), value))
            except (TypeError, ValueError):
                continue  # 畸形键跳过（不崩溃、不伪造）
        items.sort(key=lambda pair: pair[0])
    elif isinstance(raw_coordinates, list):
        items = list(enumerate(raw_coordinates))
    else:
        items = []
    # v1.7 标定映射（cloud-observed）：qubit_metrics 按 id 索引——
    # readout=√(measure_f0·measure_f1)（两方向读出几何平均，与迁移编译器
    # 的质量定义一致）；单比特门=xeb_fidelity；t1/t2 原样（µs），t2 夹取
    # ≤2·t1（物理上界，防御云端偶发坏点）；缺项 → None（诚实降级）
    qubit_cal: dict[int, dict[str, Any]] = {}
    for entry in (raw.get("properties") or {}).get("qubit_metrics") or []:
        if isinstance(entry, dict) and isinstance(entry.get("id"), int):
            qubit_cal[entry["id"]] = entry

    def _finite_or_none(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if value == value and value not in (float("inf"), float("-inf")) else None

    qubits: list[dict[str, Any]] = []
    rows = cols = 1
    for qubit_id, coordinate in items:
        if not isinstance(coordinate, (list, tuple)) or len(coordinate) < 2:
            continue  # 畸形坐标点跳过（不崩溃、不伪造位置）
        try:
            x, y = int(coordinate[0]), int(coordinate[1])
        except (TypeError, ValueError):
            continue
        rows = max(rows, y + 1)
        cols = max(cols, x + 1)
        cal = qubit_cal.get(qubit_id, {})
        f0 = _finite_or_none(cal.get("measure_f0"))
        f1 = _finite_or_none(cal.get("measure_f1"))
        readout = (f0 * f1) ** 0.5 if f0 is not None and f1 is not None else None
        t1 = _finite_or_none(cal.get("t1"))
        t2 = _finite_or_none(cal.get("t2"))
        if t1 is not None and t2 is not None:
            t2 = min(t2, 2.0 * t1)  # 物理上界（t2 ≤ 2·t1）
        qubits.append(
            {
                "id": qubit_id,
                "x": x,
                "y": y,
                "t1_us": t1,
                "t2_us": t2,
                "readout_fidelity": readout,
                "sq_fidelity": _finite_or_none(cal.get("xeb_fidelity")),
            }
        )
    # 云端显式 rows/cols 优先（cloud-observed 事实；缺省退回坐标极值+1）
    explicit_rows, explicit_cols = topology.get("rows"), topology.get("cols")
    if isinstance(explicit_rows, int) and explicit_rows >= 1:
        rows = explicit_rows
    if isinstance(explicit_cols, int) and explicit_cols >= 1:
        cols = explicit_cols
    couplers: list[dict[str, Any]] = []
    # v1.7：coupler_metrics（[a,b]→cz_fidelity）映射两比特门保真度；
    # 无标定数据的耦合对 → null（诚实降级，绝不编造数值）
    coupler_cal: dict[tuple[int, int], float] = {}
    for entry in (raw.get("properties") or {}).get("coupler_metrics") or []:
        if not isinstance(entry, dict):
            continue
        pair = entry.get("qubits")
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            try:
                key = (min(int(pair[0]), int(pair[1])), max(int(pair[0]), int(pair[1])))
            except (TypeError, ValueError):
                continue
            fidelity = _finite_or_none(entry.get("cz_fidelity"))
            if fidelity is not None:
                coupler_cal[key] = fidelity
    for pair in topology.get("coupling_map") or []:
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            try:
                a, b = int(pair[0]), int(pair[1])
            except (TypeError, ValueError):
                continue  # 畸形耦合对跳过
            key = (min(a, b), max(a, b))
            couplers.append(
                {"a": a, "b": b, "tq_fidelity": coupler_cal.get(key)}
            )
    return {
        "qubits_count": len(qubits),
        "source": "cloud-observed",
        "topology": {
            "layout": "cloud",
            "rows": rows,
            "cols": cols,
            "qubits": qubits,
            "couplers": couplers,
        },
    }


def build_node_registry(
    config: HardwareConfig,
    *,
    adapter: "LqCloudAdapter | None" = None,
    rng: random.Random | None = None,
) -> "NodeRegistry":
    """按 provider 模式构建注册表（组装根入口；fail-fast 于启动）。

    :param adapter: logicalcloud 模式的适配器（测试注入 FakeCloudProvider
        包装；None 时按 config 构造真实 ``LQCloudProvider``——密钥环境
        变量缺失或 lqcloud 未安装 → :class:`ConfigError`）。
    :raises ConfigError: logicalcloud 模式密钥缺失/依赖缺失/云端拉取失败
        （带原因——真实模式禁止静默回退到伪造数据）。
    """
    cloud_nodes: list[HardwareNode] = []
    if config.provider == "logicalcloud":
        effective = adapter if adapter is not None else make_cloud_adapter(config)
        try:
            backends = effective.list_backends()
        except Exception as exc:  # SDK 异常一律转启动失败（带原因）
            raise ConfigError(
                f"hardware provider 'logicalcloud' failed to fetch backends "
                f"from {config.lqcloud_base_url}: {exc}"
            ) from exc
        if not backends:
            raise ConfigError(
                "hardware provider 'logicalcloud' returned an empty backend "
                "list; refusing to start with zero QPUs"
            )
        cloud_nodes = build_cloud_nodes(backends)
    return NodeRegistry(config, rng=rng, cloud_nodes=cloud_nodes)


def make_cloud_adapter(config: HardwareConfig) -> "LqCloudAdapter":
    """生产适配器：读密钥环境变量 → 构造真实 LQCloudProvider（不写盘）。

    密钥缺失 / lqcloud 未安装 → :class:`ConfigError`（启动 fail-fast）；
    组装根在 logicalcloud 模式下调用一次，注册表实拉与步骤 runner 共用。
    """
    from qap.hardware.lqcloud_adapter import LqCloudAdapter

    api_key = os.environ.get(config.lqcloud_api_key_env)
    if not api_key:
        raise ConfigError(
            f"hardware provider 'logicalcloud' requires environment variable "
            f"{config.lqcloud_api_key_env!r} (hardware.lqcloud_api_key_env) "
            "to be set; refusing to start without real credentials"
        )
    try:
        from lqcloud import LQCloudProvider
    except ImportError as exc:  # pragma: no cover - extra 未安装路径
        raise ConfigError(
            "hardware provider 'logicalcloud' requires the optional extra; "
            'install with: pip install -e ".[hardware]"'
        ) from exc
    return LqCloudAdapter(
        LQCloudProvider(
            api_key=api_key,
            url=config.lqcloud_base_url,
            interactive=False,  # 非交互环境：缺凭据直接抛错，不阻塞终端
            store=False,        # 不落 ~/.lqcloud 本地任务库（服务进程）
        )
    )


class NodeRegistry:
    """进程内硬件注册表（按配置顺序保序，事件推送的节点顺序以此为准）。

    ``cloud_nodes``（v1.4 logicalcloud 模式）排在前（真机是主角），
    随后是 config 手写节点中**非 qpu** 的部分（gpu/cpu 模拟节点）；
    ``simulated_ids()`` 只含手写节点——模拟器据此跳过云拉节点。
    """

    def __init__(
        self,
        config: HardwareConfig,
        *,
        rng: random.Random | None = None,
        cloud_nodes: Sequence[HardwareNode] | None = None,
    ) -> None:
        self._nodes: dict[str, HardwareNode] = {}
        self._order: list[str] = []
        self._simulated_order: list[str] = []
        #: v1.7 计算节点执行端点表（node_id → worker URL）——classical
        #: code 步的分发目标；未登记的节点不支持代码执行
        self._exec_endpoints: dict[str, str] = {}
        source = rng if rng is not None else random.Random()
        # 1) 云拉节点（cloud-observed，不参与模拟器漂移）
        for node in cloud_nodes or []:
            self._insert(node, simulated=False)
        # 2) config 手写节点：logicalcloud 模式忽略 qpu（真机已实拉）
        for node_config in config.nodes:
            if config.provider == "logicalcloud" and node_config.kind == "qpu":
                continue  # 手写 qpu 被忽略（契约 §3 v1.4）
            node = HardwareNode(
                id=node_config.id,
                kind=node_config.kind,
                name=node_config.name,
                model=node_config.model,
                capacity=node_config.capacity,
                status=node_config.status,
                metrics=build_initial_metrics(node_config, source),
            )
            self._insert(node, simulated=True)
            if node_config.exec_url and node_config.kind in ("cpu", "gpu"):
                self._exec_endpoints[node_config.id] = node_config.exec_url

    def _insert(self, node: HardwareNode, *, simulated: bool) -> None:
        """插入节点（重复 id 防御性拒绝），维护全局序与 simulated 子序。"""
        if node.id in self._nodes:
            raise ValueError(f"duplicate node id {node.id!r}")
        self._nodes[node.id] = node
        self._order.append(node.id)
        if simulated:
            self._simulated_order.append(node.id)

    # ---------- 查询 ----------

    def get(self, node_id: str) -> HardwareNode:
        """取内部权威实例（仅分配器/模拟器使用；业务代码请用 snapshot）。"""
        node = self._nodes.get(node_id)
        if node is None:
            raise KeyError(f"unknown hardware node {node_id!r}")
        return node

    def find(self, node_id: str) -> HardwareNode | None:
        """按 id 查找，不存在返回 None（区别于 get 的 KeyError）。"""
        return self._nodes.get(node_id)

    def snapshot(self) -> list[HardwareNode]:
        """全量节点深拷贝（API/事件/工具的统一出口，按注册顺序）。"""
        return [copy.deepcopy(self._nodes[node_id]) for node_id in self._order]

    def exec_endpoint(self, node_id: str) -> str | None:
        """节点执行端点（未配置/不存在 → None）。"""
        return self._exec_endpoints.get(node_id)

    def code_capable_ids(self) -> tuple[str, ...]:
        """支持代码执行且在线的 cpu/gpu 节点（分发兜底候选，按注册序）。"""
        return tuple(
            node_id
            for node_id in self._order
            if node_id in self._exec_endpoints
            and (n := self._nodes.get(node_id)) is not None
            and n.kind in ("cpu", "gpu")
            and n.status == "online"
        )

    def all_ids(self) -> tuple[str, ...]:
        return tuple(self._order)

    def simulated_ids(self) -> tuple[str, ...]:
        """参与模拟器漂移的节点 id（v1.4：云拉 lq-* 节点不在此列）。"""
        return tuple(self._simulated_order)

    def __len__(self) -> int:
        return len(self._nodes)

    # ---------- 变更（内部协作者使用） ----------

    def set_status(self, node_id: str, status: NodeStatus) -> None:
        """上线/下线节点（负样本测试与管理入口）。"""
        self.get(node_id).status = status

    def set_utilization(self, node_id: str, value: float) -> None:
        """更新利用率；非法值（NaN/±inf/越界）由模型校验拒绝。"""
        self.get(node_id).utilization = value

    def set_metrics(self, node_id: str, metrics: dict | None) -> None:
        """整体替换该节点的 metrics（模拟器漂移专用；dict 为值拷贝语义）。

        调用方（模拟器）负责保证漂移构造性满足 §4 v1.2 不变量；
        本方法做防御性深拷贝，避免外部字典与内部状态共享引用。
        """
        self.get(node_id).metrics = copy.deepcopy(metrics)
