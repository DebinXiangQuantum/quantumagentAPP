"""领域模型：契约 §4 的序列化 JSON 结构（Pydantic v2）。

不变量（本模块强制或配合校验）：
- ``utilization ∈ [0,1]`` 且必须有限（NaN/±inf 拒绝）；
- 所有带 ``-`` 前缀的 id 由 :class:`qap.core.ids.IdGenerator` 产生，
  本模块只做形状校验（前缀正确性），全局唯一性由生成器保证；
- Artifact 载荷在**构造时**即校验（非法载荷生成侧拒绝，见 artifacts.py）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator

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
    ``attachments``（v1.3）：随消息发送的附件元数据（缺省 []；POST
    messages 的 ``attachment_ids`` 校验后落到 user 消息上）——字节本体
    在 AttachmentStore，Provider 注入由 Runtime 的 resolver 完成。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^m-\d+$")
    conversation_id: str = Field(pattern=r"^c-\d+$")
    role: Literal["user", "assistant"]
    content: str
    reasoning: str = ""
    agent_id: str = Field(min_length=1)
    artifacts: list[Artifact] = Field(default_factory=list)
    attachments: list[AttachmentMeta] = Field(default_factory=list)
    created_at: str


class Step(BaseModel):
    """任务中的一个步骤（契约 §4 Step，v1.3 增实测 profile 字段）。

    ``node_id`` 未调度时为 null；``depends_on`` 引用同一 Task 内其他 Step id
    （DAG 完整性校验见 orchestrator/dag.py）。

    v1.3 实测 profile（**measured**：真实执行的真实测量值，非编造、
    亦非硬件观测；未完成/不可得为 null）：
    - ``duration_ms``：perf_counter 墙钟差（毫秒，1 位小数，≥ 0）；
    - ``peak_memory_mb``：tracemalloc 峰值（MB，1 位小数，> 0 或 null；
      dispatch_agent 步与低于 0.05MB 精度下限的测量为 null）；
    - ``subtask_id``：该步执行期间子 Agent 经 submit_task 提交的任务 id
      （运行时上下文自动挂接，一次一层；非手工指定）。
    v1.4 云执行字段（**cloud-observed**：logicalcloud 真机观测）：
    - ``circuit``：quantum 步可携带线路（§6 CircuitPayload 同构；
      logicalcloud 模式将真实提交执行；载荷构造期校验）；
    - ``cloud_job_id``：云端任务 id；
    - ``queue_position``：排队位置（int|null，排队期间经 task.updated
      持续更新）。
    ``workload``：runner 执行参数（如 quantum 步的 qubit 数），仅运行时
    使用，**不进入序列化**（契约 §4 Step 字段保持纯净）。
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
    duration_ms: float | None = Field(default=None, ge=0)
    peak_memory_mb: float | None = Field(default=None, gt=0)
    subtask_id: str | None = None
    circuit: dict[str, Any] | None = None
    cloud_job_id: str | None = None
    queue_position: int | None = Field(default=None, ge=0)
    workload: dict[str, Any] = Field(default_factory=dict, exclude=True)
    detail: str = ""
    error: str | None = None

    @field_validator("circuit")
    @classmethod
    def _validate_circuit(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        """v1.4：circuit 载荷按 §6 circuit 约束构造期校验（null 放行）。"""
        if value is not None:
            validate_artifact_payload("circuit", value)
        return value

    @field_validator("peak_memory_mb")
    @classmethod
    def _peak_positive_or_none(cls, value: float | None) -> float | None:
        """不变量 5：peak_memory_mb > 0 或 null（0.0 视为不可表示 → 拒绝）。"""
        if value is not None and value <= 0:
            raise ValueError(f"peak_memory_mb must be > 0 or null, got {value}")
        return value


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

    #: 该任务被提交时所处的工作深度（0=会话主运行；≥1=dispatch 子运行内，
    #: 其 agent 步不可再分派——"一次一层"）。运行时内部字段，不序列化。
    _submit_depth: int = PrivateAttr(default=0)

    #: 提交该任务的 ToolContext 所属消息 id（v1.4：quantum 步自动 emit 的
    #: counts artifact 以此为 SSE 锚点并回写消息产物列表）。运行时内部
    #: 字段，不序列化；非工具路径提交（测试直提）为 None。
    _message_id: str | None = PrivateAttr(default=None)


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
