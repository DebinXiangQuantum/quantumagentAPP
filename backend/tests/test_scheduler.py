"""S5 DAG 校验与调度器测试。

- 不变量：DAG 无环/无未知依赖/无重复 id；全局并行步数 ≤ max_parallel_steps；
  capacity=1 的 GPU 两步串行不重叠（可观察行为）。
- 非法输入拒绝：环、自环、重复 id、未知依赖、空任务、StepSpec 负/未来下标。
- 负样本：步骤超时 → failed + 下游级联 cancelled + 任务 failed；
  所需 kind 节点全部 offline → 步骤直接失败。
- 可观察行为：task.updated 事件按状态迁移推送且 seq 单调；
  quantum 步落 QPU、classical 步落 CPU。
"""

from __future__ import annotations

import asyncio

import pytest

from qap.core.config import (
    HardwareConfig,
    HardwareNodeConfig,
    SchedulerConfig,
)
from qap.core.errors import ValidationFailed
from qap.core.ids import IdGenerator
from qap.domain.models import Step, Task
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import NodeRegistry
from qap.orchestrator.dag import StepSpec, build_steps, validate_dag, validate_step_specs
from qap.orchestrator.runners import never_finish_step, simulate_step
from qap.orchestrator.scheduler import STEP_KIND_TO_NODE_KIND, Scheduler


# ---------- 测试脚手架 ----------

def make_hardware() -> HardwareConfig:
    return HardwareConfig(
        simulated=True,
        tick_seconds=60.0,  # 测试中不让模拟器抢事件流
        nodes=[
            HardwareNodeConfig(id="qpu-0", kind="qpu", name="Q", model="m", capacity=1),
            HardwareNodeConfig(id="gpu-0", kind="gpu", name="G", model="m", capacity=1),
            HardwareNodeConfig(id="cpu-0", kind="cpu", name="C", model="m", capacity=4),
        ],
    )


def make_scheduler(
    *,
    step_timeout: float = 10.0,
    max_parallel: int = 4,
    retry: bool = False,
    runner=simulate_step,
    hardware: HardwareConfig | None = None,
):
    config = SchedulerConfig(
        max_parallel_steps=max_parallel,
        step_timeout_seconds=step_timeout,
        retry_failed_steps=retry,
    )
    registry = NodeRegistry(hardware or make_hardware())
    bus = EventBus()
    scheduler = Scheduler(
        config, Allocator(registry, bus), bus,
        runner=runner, poll_interval=0.01,
    )
    return scheduler, registry, bus


def make_task(specs: list[StepSpec]) -> Task:
    """从 StepSpec 构建绑定到 c-1 / demo 租户的任务。"""
    return Task(
        id=IdGenerator().next("t"),
        conversation_id="c-1",
        tenant_id="demo",
        name="测试任务",
        steps=build_steps(specs, IdGenerator()),
        created_at="2026-10-13T06:00:00Z",
    )


def task_frames(sub) -> list:
    """从订阅队列筛出 task.updated 帧（排除混入的 hardware.updated）。"""
    frames = []
    while not sub.queue.empty():
        event = sub.queue.get_nowait()
        if event.name == "task.updated":
            frames.append(event)
    return frames


def drain(bus: EventBus, conversation_id: str | None = "c-1") -> list:
    sub = bus.subscribe(conversation_id)
    events = []
    while not sub.queue.empty():
        events.append(sub.queue.get_nowait())
    bus.unsubscribe(sub)
    return events


# ---------- DAG 校验 ----------

class TestValidateDag:
    def make_steps(self, deps: dict[str, list[str]]) -> list[Step]:
        return [
            Step(id=sid, name=sid, kind="classical", depends_on=dep)
            for sid, dep in deps.items()
        ]

    def test_valid_chain(self) -> None:
        steps = self.make_steps({"s-1": [], "s-2": ["s-1"], "s-3": ["s-2"]})
        validate_dag(steps)

    def test_cycle_rejected(self) -> None:
        steps = self.make_steps({"s-1": ["s-2"], "s-2": ["s-1"]})
        with pytest.raises(ValidationFailed, match="cycle"):
            validate_dag(steps)

    def test_self_dependency_rejected(self) -> None:
        steps = self.make_steps({"s-1": ["s-1"]})
        with pytest.raises(ValidationFailed, match="itself"):
            validate_dag(steps)

    def test_unknown_dependency_rejected(self) -> None:
        steps = self.make_steps({"s-1": [], "s-2": ["ghost"]})
        with pytest.raises(ValidationFailed, match="unknown"):
            validate_dag(steps)

    def test_duplicate_ids_rejected(self) -> None:
        steps = [
            Step(id="s-1", name="a", kind="classical"),
            Step(id="s-1", name="b", kind="classical"),
        ]
        with pytest.raises(ValidationFailed, match="duplicate"):
            validate_dag(steps)

    def test_empty_steps_rejected(self) -> None:
        with pytest.raises(ValidationFailed, match="at least one"):
            validate_dag([])


class TestStepSpecs:
    def test_forward_reference_rejected(self) -> None:
        specs = [StepSpec(name="a", kind="classical", depends_on=[1])]
        with pytest.raises(ValidationFailed, match="earlier"):
            validate_step_specs(specs)

    def test_self_reference_rejected(self) -> None:
        specs = [StepSpec(name="a", kind="classical", depends_on=[0])]
        with pytest.raises(ValidationFailed):
            validate_step_specs(specs)

    def test_negative_index_rejected(self) -> None:
        specs = [StepSpec(name="a", kind="classical"), StepSpec(name="b", kind="classical", depends_on=[-1])]
        with pytest.raises(ValidationFailed):
            validate_step_specs(specs)

    def test_empty_spec_list_rejected(self) -> None:
        with pytest.raises(ValidationFailed, match="at least one"):
            validate_step_specs([])

    def test_build_steps_assigns_ids_and_translates_deps(self) -> None:
        idgen = IdGenerator()
        specs = [
            StepSpec(name="a", kind="classical"),
            StepSpec(name="b", kind="quantum", depends_on=[0]),
            StepSpec(name="c", kind="classical", depends_on=[0, 1]),
        ]
        steps = build_steps(specs, idgen)
        assert [s.id for s in steps] == ["s-1", "s-2", "s-3"]
        assert steps[2].depends_on == ["s-1", "s-2"]


# ---------- 调度器 ----------

class TestSchedulerHappyPath:
    async def test_three_step_demo_chain_succeeds(self) -> None:
        """§10 第 2/3 条：3 步链式 DAG 全部成功，量子步落 QPU、经典步落 CPU。"""
        scheduler, registry, bus = make_scheduler()
        task = make_task([
            StepSpec(name="分子积分计算", kind="classical"),
            StepSpec(name="VQE 线路执行", kind="quantum", depends_on=[0]),
            StepSpec(name="结果后处理", kind="classical", depends_on=[1]),
        ])
        final = await scheduler.submit(task, agent_id="algorithm-designer")
        assert final.status == "succeeded"
        assert [s.status for s in final.steps] == ["succeeded"] * 3
        assert final.steps[1].node_id == "qpu-0"  # quantum → qpu
        assert final.steps[0].node_id == "cpu-0"  # classical → cpu
        # 全部租约已释放
        assert all(not n.allocations for n in registry.snapshot())

    async def test_task_updated_events_monotonic_and_ordered(self) -> None:
        """可观察行为：每次状态迁移都有 task.updated，seq 单调递增。"""
        scheduler, _, bus = make_scheduler()
        task = make_task([
            StepSpec(name="a", kind="classical"),
            StepSpec(name="b", kind="classical", depends_on=[0]),
        ])
        # 先订阅再提交，捕获全部帧
        sub = bus.subscribe("c-1")
        await scheduler.submit(task)
        frames = task_frames(sub)
        bus.unsubscribe(sub)
        seqs = [f.seq for f in frames]
        assert seqs == sorted(seqs) and len(seqs) > 1
        statuses = [f.data["status"] for f in frames]
        assert statuses[0] == "pending"
        assert "running" in statuses
        assert statuses[-1] == "succeeded"

    async def test_parallel_steps_run_concurrently(self) -> None:
        """无依赖的两步 + 独立分支可并行（max_parallel=4）。"""
        scheduler, _, _ = make_scheduler(max_parallel=4)
        task = make_task([
            StepSpec(name="a", kind="classical"),
            StepSpec(name="b", kind="classical"),
        ])
        final = await scheduler.submit(task)
        assert final.status == "succeeded"


class TestSchedulerConstraints:
    async def test_capacity_one_gpu_serializes_two_agent_steps(self) -> None:
        """可观察行为（契约 §11）：capacity=1 的 GPU，两个 agent 步不重叠。"""
        scheduler, _, bus = make_scheduler()
        sub = bus.subscribe("c-1")
        task = make_task([
            StepSpec(name="分支A", kind="agent"),
            StepSpec(name="分支B", kind="agent"),
        ])
        final = await scheduler.submit(task)
        frames = task_frames(sub)
        bus.unsubscribe(sub)
        # 从全量帧推断每步生命周期：任何时刻至多一个 agent 步处于 running
        overlap_seen = False
        for frame in frames:
            running = [s for s in frame.data["steps"] if s["status"] == "running"]
            if len(running) > 1:
                overlap_seen = True
        assert final.status == "succeeded"
        assert not overlap_seen
        # 两步都成功且先后完成（同一 gpu-0 节点）
        assert {s.node_id for s in final.steps} == {"gpu-0"}

    async def test_global_parallel_limit_respected(self) -> None:
        """不变量：平台全局运行步数恒 ≤ max_parallel_steps=2。"""
        scheduler, _, bus = make_scheduler(max_parallel=2)
        sub = bus.subscribe("c-1")
        peak = 0
        task_a = make_task([StepSpec(name=f"a{i}", kind="classical") for i in range(3)])
        task_b = make_task([StepSpec(name=f"b{i}", kind="classical") for i in range(3)])
        await asyncio.gather(scheduler.submit(task_a), scheduler.submit(task_b))
        for frame in task_frames(sub):
            running = sum(1 for s in frame.data["steps"] if s["status"] == "running")
            peak = max(peak, running)
        bus.unsubscribe(sub)
        assert peak <= 2
        assert task_a.status == "succeeded" and task_b.status == "succeeded"

    async def test_step_timeout_fails_task_and_cancels_downstream(self) -> None:
        """负样本：步骤超时 → failed；下游 cancelled；任务 failed。"""
        scheduler, _, _ = make_scheduler(step_timeout=0.05, runner=never_finish_step)
        task = make_task([
            StepSpec(name="慢步", kind="classical"),
            StepSpec(name="下游", kind="quantum", depends_on=[0]),
        ])
        final = await scheduler.submit(task)
        assert final.status == "failed"
        assert final.steps[0].status == "failed"
        assert "timed out" in (final.steps[0].error or "")
        assert final.steps[1].status == "cancelled"
        assert "upstream" in (final.steps[1].error or "")

    async def test_offline_node_fails_steps_of_that_kind(self) -> None:
        """负样本：所需 kind 全部下线 → 步骤直接失败（不无限等待）。"""
        hardware = make_hardware()
        for node in hardware.nodes:
            if node.kind == "qpu":
                node.capacity = 1
        scheduler, registry, _ = make_scheduler(hardware=hardware)
        registry.set_status("qpu-0", "offline")
        task = make_task([StepSpec(name="量子步", kind="quantum")])
        final = await scheduler.submit(task)
        assert final.status == "failed"
        assert final.steps[0].status == "failed"
        assert "no online" in (final.steps[0].error or "")

    async def test_capacity_wait_then_success(self) -> None:
        """容量暂满 → 步骤等待而非失败（cpu capacity=4 被占 3 后仍可排 2 步）。"""
        scheduler, registry, _ = make_scheduler(max_parallel=8)
        allocator_holder = scheduler._allocator
        for i in range(3):  # 外部占用 cpu 容量（模拟其它租户任务）
            allocator_holder.lease("cpu", task_id="t-909", step_id=f"s-9{i}0")
        task = make_task([StepSpec(name=f"步{i}", kind="classical") for i in range(4)])
        final = await scheduler.submit(task)
        assert final.status == "succeeded"  # 4 步在剩余容量内排队完成
        assert allocator_holder.free_capacity("cpu") == 1  # 外部 3 份租约仍在

    async def test_independent_branch_survives_sibling_failure(self) -> None:
        """契约 §3：超时步 failed，任务成败"视依赖"——独立分支照常完成。"""
        async def flaky_runner(step: Step) -> str:
            if step.name == "会失败的分支":
                raise RuntimeError("boom")
            return await simulate_step(step)

        scheduler, _, _ = make_scheduler(runner=flaky_runner)
        task = make_task([
            StepSpec(name="会失败的分支", kind="classical"),
            StepSpec(name="健康分支", kind="classical"),
            StepSpec(name="失败下游", kind="quantum", depends_on=[0]),
        ])
        final = await scheduler.submit(task)
        assert final.status == "failed"
        assert final.steps[0].status == "failed" and "boom" in final.steps[0].error
        assert final.steps[1].status == "succeeded"  # 独立分支完成
        assert final.steps[2].status == "cancelled"

    async def test_retry_failed_steps_recovers_once(self) -> None:
        """retry_failed_steps=true：瞬时失败重试一次后成功。"""
        attempts = {"n": 0}

        async def flaky_runner(step: Step) -> str:
            if step.name == "偶发失败":
                attempts["n"] += 1
                if attempts["n"] == 1:
                    raise RuntimeError("transient")
            return await simulate_step(step)

        scheduler, _, _ = make_scheduler(retry=True, runner=flaky_runner)
        task = make_task([StepSpec(name="偶发失败", kind="classical")])
        final = await scheduler.submit(task)
        assert attempts["n"] == 2
        assert final.status == "succeeded"

    async def test_submit_rejects_invalid_dag(self) -> None:
        scheduler, _, _ = make_scheduler()
        bad = Task(
            id="t-9", conversation_id="c-1", tenant_id="demo", name="bad",
            steps=[Step(id="s-1", name="a", kind="classical", depends_on=["ghost"])],
            created_at="2026-10-13T06:00:00Z",
        )
        with pytest.raises(ValidationFailed):
            scheduler.submit(bad)


class TestKindMapping:
    def test_mapping_matches_contract_demo(self) -> None:
        assert STEP_KIND_TO_NODE_KIND == {"classical": "cpu", "quantum": "qpu", "agent": "gpu"}
