"""DAG 校验与步骤构建（契约 §4 不变量 1：无环 / 无未知依赖 / 无重复 id）。

两层校验：
1. :func:`validate_dag`：对**已赋 id** 的 Step 列表做通用校验（重复 id、
   未知依赖、自环、Kahn 拓扑排序检测成环）——领域不变量的权威实现，
   供调度器与测试使用；
2. :func:`validate_step_specs`：对**提交期**的 :class:`StepSpec`（尚未赋 id，
   ``depends_on`` 用前序下标表达）做更强的结构性校验——依赖下标必须
   ⊂ [0, 自身下标)。该约束**构造性**排除环与未知引用，随后
   :func:`build_steps` 生成全局唯一 ``s-`` id 并把下标翻译成 id 依赖。
"""

from __future__ import annotations

from collections import deque
from typing import Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator

from qap.core.errors import ValidationFailed
from qap.core.ids import IdGenerator
from qap.domain.artifacts import validate_artifact_payload
from qap.domain.models import Step, StepKind


class StepSpec(BaseModel):
    """提交任务时的步骤声明（``submit_task`` 工具的 steps 元素）。

    ``depends_on`` 是**前序步骤的下标**（0 起，指向更早声明的步骤），
    平台在 build_steps 时翻译为 Step id——工具入参用下标而非平台 id，
    避免 Agent 猜测/伪造全局 id（id 由 IdGenerator 统一分配）。
    ``workload``（v1.3）：runner 执行参数，见字段注释。
    ``circuit``/``shots``/``node_id``（v1.4 §9）：quantum 步真机执行
    三件套——circuit 为 §6 CircuitPayload 同构载荷（构造期校验，非法
    即拒绝提交）；shots 缺省 1024；node_id 缺省自动选首个 online QPU。
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    kind: StepKind
    detail: str = ""
    depends_on: list[int] = Field(default_factory=list)
    #: v1.3 runner 执行参数（quantum: qubits / classical: bytes / agent:
    #: agent_id+instruction）；缺省由 runner 取小规模默认值。
    workload: dict = Field(default_factory=dict)
    #: v1.4 quantum 步线路（§6 同构；序列化进 Step.circuit）
    circuit: dict | None = None
    #: v1.4 采样数（运行时参数，缺省 1024）
    shots: int | None = Field(default=None, gt=0)
    #: v1.4 指定执行节点（运行时参数；接受 lq-<name> 注册表 id 或裸后端名）
    node_id: str | None = Field(default=None, min_length=1)

    @field_validator("circuit")
    @classmethod
    def _validate_circuit(cls, value: dict | None) -> dict | None:
        """非法 circuit 载荷在提交期拒绝（契约 §9 v1.4：§6 同构校验）。"""
        if value is not None:
            validate_artifact_payload("circuit", value)
        return value

    @field_validator("node_id")
    @classmethod
    def _reject_blank_node(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("node_id must be a non-empty string when present")
        return value


def validate_dag(steps: Sequence[Step]) -> None:
    """校验 Step 列表构成合法 DAG（无重复 id / 无未知依赖 / 无环）。

    :raises ValidationFailed: 违反任一约束，消息指明具体步骤与原因。
    """
    if not steps:
        raise ValidationFailed("task must contain at least one step")
    ids = [step.id for step in steps]
    duplicates = sorted({sid for sid in ids if ids.count(sid) > 1})
    if duplicates:
        raise ValidationFailed(f"duplicate step ids: {duplicates}")
    id_set = set(ids)
    for step in steps:
        for dep in step.depends_on:
            if dep not in id_set:
                raise ValidationFailed(f"step {step.id!r} depends on unknown step {dep!r}")
        if step.id in step.depends_on:
            raise ValidationFailed(f"step {step.id!r} depends on itself")
    # Kahn 拓扑排序：处理不完即存在环。
    indegree = {step.id: len(step.depends_on) for step in steps}
    dependents: dict[str, list[str]] = {step.id: [] for step in steps}
    for step in steps:
        for dep in step.depends_on:
            dependents[dep].append(step.id)
    queue = deque(sid for sid, degree in indegree.items() if degree == 0)
    processed = 0
    while queue:
        current = queue.popleft()
        processed += 1
        for follower in dependents[current]:
            indegree[follower] -= 1
            if indegree[follower] == 0:
                queue.append(follower)
    if processed != len(steps):
        raise ValidationFailed(
            f"cycle detected in step dependencies (processed {processed}/{len(steps)})"
        )


def validate_step_specs(specs: Sequence[StepSpec]) -> None:
    """提交期校验：依赖下标必须是更早步骤的下标（结构性无环）。

    :raises ValidationFailed: 空任务 / 依赖指向自身或未来步骤 / 负下标。
    """
    if not specs:
        raise ValidationFailed("task must contain at least one step")
    for index, spec in enumerate(specs):
        for dep in spec.depends_on:
            if not 0 <= dep < index:
                raise ValidationFailed(
                    f"step[{index}] {spec.name!r}: depends_on entry {dep} must reference "
                    f"an earlier step index in [0,{index})"
                )


def build_steps(specs: Sequence[StepSpec], idgen: IdGenerator) -> list[Step]:
    """StepSpec 列表 → 赋全局唯一 id 的 Step 列表（下标依赖 → id 依赖）。

    v1.4：``circuit`` 落到序列化字段 ``Step.circuit``；``shots``/``node_id``
    为运行时参数 → ``workload``（不进入序列化，与 qubits/bytes 同族）。
    调用前应先 :func:`validate_step_specs`；本函数仍防御性再校验一次。
    """
    validate_step_specs(specs)
    id_by_index: list[str] = []
    steps: list[Step] = []
    for spec in specs:
        step_id = idgen.next("s")
        id_by_index.append(step_id)
        workload = dict(spec.workload)
        if spec.shots is not None:
            workload["shots"] = spec.shots
        if spec.node_id is not None:
            workload["node_id"] = spec.node_id
        steps.append(
            Step(
                id=step_id,
                name=spec.name,
                kind=spec.kind,
                depends_on=[id_by_index[dep] for dep in spec.depends_on],
                workload=workload,
                circuit=spec.circuit,
                detail=spec.detail,
            )
        )
    validate_dag(steps)  # 防御：结构性约束应已保证，双保险成本可忽略
    return steps
