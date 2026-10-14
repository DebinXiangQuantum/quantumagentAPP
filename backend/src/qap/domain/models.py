"""领域模型：契约 §4 的序列化 JSON 结构（Pydantic v2）。

不变量（本模块强制或配合校验）：
- ``utilization ∈ [0,1]`` 且必须有限（NaN/±inf 拒绝）；
- 所有带 ``-`` 前缀的 id 由 :class:`qap.core.ids.IdGenerator` 产生，
  本模块只做形状校验（前缀正确性），全局唯一性由生成器保证；
- Artifact 载荷在**构造时**即校验（非法载荷生成侧拒绝，见 artifacts.py）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from qap.domain.artifacts import validate_artifact_payload

#: Step/Task 共享的状态机字面量（契约 §4）
StepStatus = Literal["pending", "running", "succeeded", "failed", "cancelled"]
TaskStatus = Literal["pending", "running", "succeeded", "failed", "cancelled"]
#: 硬件节点类型与在线状态
NodeKind = Literal["qpu", "gpu", "cpu"]
NodeStatus = Literal["online", "offline"]
#: Step 的执行类别：classical→cpu 节点、quantum→qpu 节点、agent→gpu 节点
StepKind = Literal["classical", "quantum", "agent"]


def _check_finite_unit_interval(value: float) -> float:
    """利用率校验：有限且 ∈ [0,1]（不变量 3 的前半部分）。"""
    v = float(value)
    if v != v or v in (float("inf"), float("-inf")):  # NaN 与 ±inf
        raise ValueError(f"utilization must be finite, got {value!r}")
    if not 0.0 <= v <= 1.0:
        raise ValueError(f"utilization must be within [0,1], got {value}")
    return v


class AgentInfo(BaseModel):
    """已注册 Agent 插件的对外描述（契约 §4 AgentInfo）。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    capabilities: list[str] = Field(default_factory=list)
    model_ref: str = Field(min_length=1)
    builtin: bool = True


class Conversation(BaseModel):
    """会话（契约 §4 Conversation）。消息本体不内嵌，见 Message。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^c-\d+$")
    title: str = ""
    agent_id: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    created_at: str


class Artifact(BaseModel):
    """Artifact 统一信封（契约 §6）：``{id, type, title, payload}``。

    已知 type（circuit/counts/waveform）的载荷约束在构造期校验，
    非法载荷直接抛 ``ValidationFailed``（生成侧拒绝）；
    未知 type 允许通过——前端按契约对未知 type 优雅降级为 JSON 卡片，
    后端只要求 payload 是可 JSON 序列化的对象。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^a-\d+$")
    type: str = Field(min_length=1)
    title: str = ""
    payload: dict[str, Any]

    @field_validator("payload")
    @classmethod
    def _validate_payload(cls, payload: dict[str, Any], info) -> dict[str, Any]:
        validate_artifact_payload(info.data.get("type"), payload)
        return payload


class Message(BaseModel):
    """会话内一条消息（契约 §4 Message）。

    ``reasoning``（v1.1）：assistant 消息的思考过程全文（ ThoughtDelta
    增量在 Runtime 侧累加），可为空串；user 消息恒为空串。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^m-\d+$")
    conversation_id: str = Field(pattern=r"^c-\d+$")
    role: Literal["user", "assistant"]
    content: str
    reasoning: str = ""
    agent_id: str = Field(min_length=1)
    artifacts: list[Artifact] = Field(default_factory=list)
    created_at: str


class Step(BaseModel):
    """任务中的一个步骤（契约 §4 Step）。

    ``node_id`` 未调度时为 null；``depends_on`` 引用同一 Task 内其他 Step id
    （DAG 完整性校验见 orchestrator/dag.py）。
    """

    # 运行时会被调度器逐字段改写（status/node_id/...），开启赋值期校验
    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    id: str = Field(pattern=r"^s-\d+$")
    name: str = Field(min_length=1)
    kind: StepKind
    status: StepStatus = "pending"
    node_id: str | None = None
    depends_on: list[str] = Field(default_factory=list)
    started_at: str | None = None
    finished_at: str | None = None
    detail: str = ""
    error: str | None = None


class Task(BaseModel):
    """编排单位（契约 §4 Task）：步骤集合构成 DAG。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^t-\d+$")
    conversation_id: str = Field(pattern=r"^c-\d+$")
    tenant_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    status: TaskStatus = "pending"
    steps: list[Step] = Field(default_factory=list)
    created_at: str


class Allocation(BaseModel):
    """硬件节点上的一份租约（契约 §4 Allocation）。

    ``agent_id`` 记录"哪个 Agent 在用这块硬件"（§10 演示第 4 条的
    可观察行为来源）；agent 步骤为发起 Agent，其余步骤为提交任务的 Agent。
    """

    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(pattern=r"^t-\d+$")
    step_id: str = Field(pattern=r"^s-\d+$")
    agent_id: str | None = None
    leased_at: str


class HardwareNode(BaseModel):
    """硬件节点（契约 §4 HardwareNode）：容量/利用率/活动租约 + metrics。

    利用率/租约由模拟器与分配器在运行时逐字段改写，开启赋值期校验，
    保证不变量 3 在**每次变更**时都成立（而非仅在构造时）。
    ``metrics``（v1.2）按 kind 不同：QPU 拓扑+保真度、CPU 规格+用量、
    GPU 显存——内容为 **simulated** 数据（模拟器生成/漂移，非硬件观测），
    可为 None（规格缺失/旧数据，前端降级），内部结构校验见
    ``qap/hardware/metrics.py`` 的 ``validate_node_metrics``。
    """

    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    id: str = Field(min_length=1)
    kind: NodeKind
    name: str
    model: str
    status: NodeStatus = "online"
    utilization: float = 0.0
    capacity: int = Field(ge=1)
    metrics: dict[str, Any] | None = None
    allocations: list[Allocation] = Field(default_factory=list)

    @field_validator("utilization")
    @classmethod
    def _validate_utilization(cls, value: float) -> float:
        return _check_finite_unit_interval(value)


class AttachmentMeta(BaseModel):
    """附件元数据（契约 §5 v1.3）：上传响应与 Message.attachments 元素。

    ``kind`` 判定：mime ``image/*`` → image；``text/*`` 或文本扩展名
    {.md,.txt,.py,.json,.toml,.csv,.yaml,.ts,.js} → text；其余 file。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^att-\d+$")
    name: str = Field(min_length=1)
    mime: str = Field(min_length=1)
    size: int = Field(ge=0)
    kind: Literal["image", "text", "file"]
