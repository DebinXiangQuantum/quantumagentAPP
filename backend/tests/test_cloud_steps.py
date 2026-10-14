"""V3 quantum 步真实执行测试（契约 §4 v1.4 Step 新字段 / §9 v1.4）。

四类场景：
- 不变量：Step 序列化含 circuit/cloud_job_id/queue_position（缺省 null）；
  StepSpec 接受可选 circuit/shots/node_id 并落位；真实链路 counts artifact
  计数守恒（sum == 实际 shots）且标题注明后端名与 job_id。
- 非法输入拒绝：StepSpec 携带非法 circuit 载荷（越界下标/未知结构）→
  ValidationFailed；shots 非正整数拒绝；node_id 空白拒绝。
- 负样本：云端任务终态 failed → step.error 含服务端错误；指定离线/
  未知节点 → 拒绝执行（诚实报错）。
- 可观察行为：真实链（FakeCloudProvider）queue_position 变化经
  task.updated 推送 ≥2 次；cloud_job_id 记录；simulated 模式（无 circuit）
  回退既有真实计算负载（行为不变）。
"""

from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError

from qap.core.config import SchedulerConfig
from qap.core.errors import ValidationFailed
from qap.core.ids import IdGenerator
from qap.domain.models import Step, Task
from qap.events.bus import EventBus
from qap.hardware.lqcloud_adapter import LqCloudAdapter
from qap.orchestrator.cloud_runner import CloudStepRunner
from qap.orchestrator.dag import StepSpec, build_steps
from qap.orchestrator.scheduler import Scheduler
from qap.hardware.allocator import Allocator
from tests.fake_cloud import FakeCloudProvider
from tests.test_hardware_provider import logicalcloud_config

import random


BELL_CIRCUIT = {
    "qubits": 2,
    "operations": [
        {"id": "op-0", "gate": "H", "targets": [0]},
        {"id": "op-1", "gate": "CNOT", "controls": [0], "targets": [1]},
        {"id": "op-2", "gate": "MEASURE", "targets": [0, 1]},
    ],
}


class TestStepNewFields:
    def test_step_serialization_carries_v14_fields_defaulting_null(self) -> None:
        step = Step(id="s-1", name="q", kind="quantum")
        dumped = step.model_dump()
        assert dumped["circuit"] is None
        assert dumped["cloud_job_id"] is None
        assert dumped["queue_position"] is None

    def test_step_carries_circuit_and_cloud_fields(self) -> None:
        step = Step(id="s-2", name="q", kind="quantum", circuit=BELL_CIRCUIT)
        step.cloud_job_id = "task_0001"
        step.queue_position = 3
        dumped = step.model_dump()
        assert dumped["circuit"] == BELL_CIRCUIT
        assert dumped["cloud_job_id"] == "task_0001"
        assert dumped["queue_position"] == 3

    def test_step_rejects_malformed_circuit_payload(self) -> None:
        bad = {"qubits": 2, "operations": [{"id": "o", "gate": "H", "targets": [5]}]}
        with pytest.raises(ValidationFailed):
            Step(id="s-3", name="q", kind="quantum", circuit=bad)


class TestStepSpecV14:
    def test_spec_accepts_circuit_shots_node_id(self) -> None:
        spec = StepSpec.model_validate(
            {
                "name": "Bell 真机执行", "kind": "quantum",
                "circuit": BELL_CIRCUIT, "shots": 256, "node_id": "lq-MQ02",
            }
        )
        steps = build_steps([spec], IdGenerator())
        assert steps[0].circuit == BELL_CIRCUIT
        assert steps[0].workload["shots"] == 256
        assert steps[0].workload["node_id"] == "lq-MQ02"

    def test_spec_defaults_circuit_absent(self) -> None:
        steps = build_steps(
            [StepSpec(name="经典步", kind="classical")], IdGenerator()
        )
        assert steps[0].circuit is None

    def test_spec_rejects_invalid_circuit(self) -> None:
        bad = {"qubits": 0, "operations": []}
        with pytest.raises(ValidationFailed):
            StepSpec(name="x", kind="quantum", circuit=bad)

    def test_spec_rejects_bad_shots_and_blank_node(self) -> None:
        with pytest.raises(ValidationError):  # 数值约束由 pydantic 收敛
            StepSpec(name="x", kind="quantum", shots=0)
        with pytest.raises(ValidationError):  # 空白 node_id 提交期拒绝
            StepSpec(name="x", kind="quantum", node_id="  ")


# ---------- 真实执行链（FakeCloudProvider 注入，零网络） ----------

class CloudRig:
    """logicalcloud 模式的最小平台束（注册表实拉 + 云 runner + 调度器）。"""

    def __init__(self, provider: FakeCloudProvider | None = None):
        from qap.hardware.registry import build_node_registry

        self.provider = provider or FakeCloudProvider(
            poll_script=[
                ("queued", 2), ("queued", 1), ("running", None), ("completed", None),
            ],
            counts={"00": 124, "11": 120, "01": 6, "10": 6},
        )
        self.adapter = LqCloudAdapter(self.provider)
        self.bus = EventBus()
        self.registry = build_node_registry(
            logicalcloud_config(), adapter=self.adapter, rng=random.Random(7)
        )
        self.allocator = Allocator(self.registry, self.bus)
        self.emitted: list[dict] = []

    def emitter(self, task, step, artifact_type, title, payload) -> dict:
        record = {
            "task_id": task.id, "step_id": step.id, "type": artifact_type,
            "title": title, "payload": payload,
        }
        self.emitted.append(record)
        return record

    def make_runner(self) -> CloudStepRunner:
        return CloudStepRunner(
            adapter=self.adapter, registry=self.registry, events=self.bus,
            artifact_emitter=self.emitter, poll_interval=0.01,
        )

    async def run_task(self, specs: list[StepSpec], *, agent_id="algorithm-designer") -> Task:
        self.scheduler = Scheduler(
            SchedulerConfig(max_parallel_steps=4, step_timeout_seconds=8.0,
                            retry_failed_steps=False),
            self.allocator, self.bus, runner=self.make_runner(),
            poll_interval=0.01,
        )
        task = Task(
            id="t-1", conversation_id="c-1", tenant_id="demo",
            name="真机任务", steps=build_steps(specs, IdGenerator()),
            created_at="2026-10-14T00:00:00Z",
        )
        submitted = self.scheduler.submit(task, agent_id=agent_id)
        return await submitted

    def task_frames(self) -> list[dict]:
        """回放会话流的 task.updated 帧（replay 而非 subscribe：订阅不回放）。"""
        return [
            event.data
            for event in self.bus.replay(None, conversation_id="c-1")
            if event.name == "task.updated"
        ]


@pytest.fixture()
def rig() -> CloudRig:
    return CloudRig()


class TestCloudQuantumExecution:
    async def test_full_chain_records_job_counts_artifact_and_timing(self, rig) -> None:
        """真实链：succeeded + cloud_job_id + counts artifact（标题含后端名与
        job_id，计数守恒）+ detail 实测等待/执行时长。"""
        task = await rig.run_task([
            StepSpec(name="Bell 真机执行", kind="quantum",
                     circuit=BELL_CIRCUIT, shots=256),
        ])
        assert task.status == "succeeded", task.steps[0].error
        step = task.steps[0]
        assert step.cloud_job_id and step.cloud_job_id.startswith("task_")
        assert step.status == "succeeded"
        # counts artifact 自动产生（cloud-observed 真实测量）
        assert len(rig.emitted) == 1
        record = rig.emitted[0]
        assert record["type"] == "counts"
        assert "MQ02" in record["title"] and step.cloud_job_id in record["title"]
        payload = record["payload"]
        assert payload["qubits"] == 2
        assert sum(payload["counts"].values()) == payload["shots"] == 256
        assert "cloud-observed" in step.detail and "等待" in step.detail

    async def test_queue_position_updates_pushed_at_least_twice(self, rig) -> None:
        """排队位置 2 → 1 → None：task.updated 至少推送 2 次位置变化。"""
        await rig.run_task([
            StepSpec(name="排队外显", kind="quantum", circuit=BELL_CIRCUIT, shots=64),
        ])
        frames = rig.task_frames()
        positions = [f["steps"][0].get("queue_position") for f in frames]
        assert 2 in positions and 1 in positions  # ≥2 次位置推进均可见
        # 位置单调不回升（2 → 1 → None）
        seen = [p for p in positions if p is not None]
        assert seen == sorted(seen, reverse=True) or seen == [2, 1]

    async def test_specified_node_selects_backend(self, rig) -> None:
        """workload.node_id 指定 lq-AGate-100 → 提交落在 AGate-100。"""
        await rig.run_task([
            StepSpec(name="指定节点", kind="quantum", circuit=BELL_CIRCUIT,
                     shots=64, node_id="lq-AGate-100"),
        ])
        assert rig.provider.submissions[0]["backend_name"] == "AGate-100"

    async def test_failed_job_reports_server_error(self) -> None:
        rig = CloudRig(FakeCloudProvider(
            poll_script=[("queued", 1), ("failed", None)],
            terminal_error="qubit 3 readout timeout",
        ))
        task = await rig.run_task([
            StepSpec(name="失败链", kind="quantum", circuit=BELL_CIRCUIT, shots=64),
        ])
        step = task.steps[0]
        assert step.status == "failed"
        assert "readout timeout" in (step.error or "")
        assert rig.emitted == []  # 失败不产 counts artifact

    async def test_offline_node_rejected_honestly(self, rig) -> None:
        task = await rig.run_task([
            StepSpec(name="离线节点", kind="quantum", circuit=BELL_CIRCUIT,
                     shots=64, node_id="lq-QZ02"),
        ])
        step = task.steps[0]
        assert step.status == "failed"
        assert "offline" in (step.error or "")

    async def test_simulated_fallback_without_circuit(self, rig) -> None:
        """logicalcloud 模式下无 circuit 的 quantum 步 → 既有真实计算负载。"""
        task = await rig.run_task([
            StepSpec(name="本地模拟", kind="quantum", workload={"qubits": 4}),
        ])
        step = task.steps[0]
        assert step.status == "succeeded"
        assert "statevector" in step.detail  # runners.simulate_step 既有语义
        assert step.cloud_job_id is None
        assert rig.provider.submissions == []

    async def test_classical_step_unchanged_in_cloud_mode(self, rig) -> None:
        task = await rig.run_task([
            StepSpec(name="经典步", kind="classical", workload={"bytes": 4096}),
        ])
        assert task.status == "succeeded"
        assert "classical JSON zlib roundtrip" in task.steps[0].detail


class TestAppStateWiring:
    async def test_state_emits_artifact_created_with_message_anchor(self) -> None:
        """组装根全链：logicalcloud 配置 + 注入适配器 → submit_task（带
        circuit/shots）→ 真机步完成 → artifact.created 即时事件（载荷含
        归属消息锚点）+ 消息产物列表回写。"""
        from qap.agents.tools import PlatformTools, ToolContext
        from qap.api.state import build_app_state
        from qap.tenancy.service import TenantService

        provider = FakeCloudProvider(
            poll_script=[("queued", 1), ("running", None), ("completed", None)],
            counts={"00": 130, "11": 126},
        )
        state = build_app_state(_logicalcloud_app_config(), cloud_adapter=LqCloudAdapter(provider))
        conversation = state.new_conversation(
            "algorithm-designer", "真机会话", "demo"
        )
        state.conversations.add(conversation)
        user = state.new_message(conversation.id, "user", "跑 Bell 256", "algorithm-designer")
        assistant = state.new_message(conversation.id, "assistant", "", "algorithm-designer")
        state.messages.add(user)
        state.messages.add(assistant)
        context = ToolContext(
            conversation_id=conversation.id, tenant_id="demo",
            agent_id="algorithm-designer", message_id=assistant.id,
            run_key=f"{conversation.id}:{assistant.id}",
        )
        result = json.loads(await state.tools.execute(
            context, "submit_task",
            json.dumps({
                "name": "Bell 真机",
                "steps": [{"name": "Bell 执行", "kind": "quantum",
                           "circuit": BELL_CIRCUIT, "shots": 256}],
            }, ensure_ascii=False),
        ))
        task_id = result["task_id"]
        for _ in range(200):  # 等任务终态（轮询，避免固定 sleep）
            if state.tasks.get(task_id, "demo").status in ("succeeded", "failed", "cancelled"):
                break
            await asyncio.sleep(0.02)
        assert state.tasks.get(task_id, "demo").status == "succeeded"
        # artifact.created 即时事件：载荷含消息锚点与 counts 信封
        events = [
            e for e in state.events.replay(None, conversation_id=conversation.id)
            if e.name == "artifact.created"
        ]
        assert len(events) == 1
        data = events[0].data
        assert data["message_id"] == assistant.id
        assert data["artifact"]["type"] == "counts"
        assert sum(data["artifact"]["payload"]["counts"].values()) == 256
        # 消息产物列表已回写（会话刷新可见）
        stored = next(m for m in state.messages.list(conversation.id) if m.id == assistant.id)
        assert [a.type for a in stored.artifacts] == ["counts"]


def _logicalcloud_app_config():
    """logicalcloud 模式的完整 AppConfig（复用集成测试工厂）。"""
    from tests.test_api_integration import make_test_config
    from qap.core.config import HardwareConfig, HardwareNodeConfig

    config = make_test_config()
    config.hardware = HardwareConfig(
        provider="logicalcloud",
        simulated=False,
        tick_seconds=60.0,
        nodes=[
            HardwareNodeConfig(id="gpu-a800-0", kind="gpu", name="A800 #0",
                               model="NVIDIA A800 80GB", capacity=1, vram_total_gb=80.0),
            HardwareNodeConfig(id="cpu-node-0", kind="cpu", name="经典 #0",
                               model="EPYC", capacity=4, cpu_cores=64, memory_total_gb=256.0),
        ],
    )
    return config


class TestCircuitlessQuantumHonestAnnotation:
    """v1.4：云模式下 quantum 步未携带线路 → 委托本地负载但 detail 必须诚实
    标注"本地模拟（未提交真机）"，杜绝把模拟结果误读为真机执行。"""

    def _bare_step(self, sid: str) -> "Step":
        from qap.domain.models import Step

        return Step(
            id=sid, name="无线路量子步", kind="quantum", status="running",
            node_id=None, depends_on=[], started_at=None, finished_at=None,
            detail="", error=None,
        )

    async def test_circuitless_quantum_detail_annotated(self, rig: "CloudRig") -> None:
        step = self._bare_step("s-1")
        runner = CloudStepRunner(
            adapter=rig.adapter, registry=rig.registry, events=rig.bus,
            poll_interval=0.01,
        )  # adapter 非 None = 云模式
        outcome = await runner(step)
        # fallback 返回其详情串（非状态字）；标注必须落在 step.detail 上
        assert isinstance(outcome, str) and len(outcome) > 0
        assert "本地模拟" in step.detail and "未提交真机" in step.detail

    async def test_simulated_mode_no_annotation(self, rig: "CloudRig") -> None:
        step = self._bare_step("s-2")
        runner = CloudStepRunner(
            adapter=None, registry=rig.registry, events=rig.bus,
            poll_interval=0.01,
        )  # 模拟模式：无需标注
        await runner(step)
        assert "未提交真机" not in step.detail


class TestFuzzyNodeResolution:
    """v1.4 真实联调缺陷：GLM 传模糊节点名（如 "logicalcloud"）→ 拼成
    lq-logicalcloud 报 unknown 直接失败。语义修正：
    - 归一化（裸名/带前缀/大小写不敏感包含匹配）命中且在线 → 使用；
    - 归一化命中但离线 → 诚实报错（不许静默改投）；
    - 完全未识别 → **兜底自动选首个在线 QPU**并在 detail 注明
      "未识别节点 X，已自动选择 Y"（LLM 传模糊名是常态，非异常）。
    """

    def _step_with(self, node_ref: str) -> "Step":
        from qap.domain.models import Step

        return Step(
            id="s-1", name="模糊节点量子步", kind="quantum", status="running",
            node_id=None, depends_on=[], started_at=None, finished_at=None,
            detail="", error=None,
            circuit={"qubits": 2, "operations": [
                {"id": "op-0", "gate": "H", "targets": [0]},
                {"id": "op-1", "gate": "CNOT", "controls": [0], "targets": [1]},
                {"id": "op-2", "gate": "MEASURE", "targets": [0, 1]},
            ]},
            workload={"node_id": node_ref, "shots": 64},
        )

    async def test_unknown_name_falls_back_with_note(self, rig: "CloudRig") -> None:
        step = self._step_with("logicalcloud")  # GLM 实际传过的模糊名
        runner = CloudStepRunner(
            adapter=rig.adapter, registry=rig.registry, events=rig.bus,
            artifact_emitter=rig.emitter, poll_interval=0.01,
        )
        outcome = await runner(step)
        assert "已自动选择" in step.detail and "未识别节点" in step.detail
        assert step.node_id and step.node_id.startswith("lq-")
        # counts artifact 发射依赖调度器注入的 Task 上下文（current_running_task），
        # 直呼 runner 的单元路径不适用——由 run_task 调度器路径用例覆盖

    async def test_bare_backend_name_normalizes(self, rig: "CloudRig") -> None:
        step = self._step_with("MQ02")
        runner = CloudStepRunner(
            adapter=rig.adapter, registry=rig.registry, events=rig.bus,
            artifact_emitter=rig.emitter, poll_interval=0.01,
        )
        await runner(step)
        assert step.node_id == "lq-MQ02"

    async def test_offline_node_still_honest_error(self, rig: "CloudRig") -> None:
        step = self._step_with("QZ02")  # 现网离线真机（fixtures 同构）
        runner = CloudStepRunner(
            adapter=rig.adapter, registry=rig.registry, events=rig.bus,
            artifact_emitter=rig.emitter, poll_interval=0.01,
        )
        import pytest
        with pytest.raises(RuntimeError, match="offline"):
            await runner(step)
