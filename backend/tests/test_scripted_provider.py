"""S6 ScriptedTestProvider 测试（v1.6 去 mock 化：测试替身只存在 tests/）。

- 不变量：默认剧本的 circuit/counts/waveform 载荷能通过 §6 校验；
  submit_task 步骤说明通过 StepSpec 校验。
- 非法输入拒绝：无——（替身是受控输入面）；未知剧本 agent 回退单条说明。
- 负样本：("error", ...) 项 → ProviderErrorEvent 且无 TurnCompleted。
- 可观察行为：同一 run_key 逐轮推进、不同 run_key 互不干扰、
  arguments 是合法 JSON 字符串；协议形状与 LLMProvider 一致
  （Runtime/集成测试以其驱动端到端链路）。
"""

from __future__ import annotations

import json

from qap.agents.providers.base import (
    CompletionRequest,
    ProviderErrorEvent,
    TextDelta,
    ToolCall,
    TurnCompleted,
)
from qap.domain.artifacts import validate_artifact_payload
from qap.orchestrator.dag import StepSpec, validate_step_specs
from tests.scripted_provider import ScriptedTestProvider, default_demo_artifacts


def request_for(agent_id: str, run_key: str) -> CompletionRequest:
    return CompletionRequest(
        model="scripted-demo",
        messages=[{"role": "user", "content": "请设计 VQE 方案"}],
        metadata={"agent_id": agent_id, "run_key": run_key},
    )


async def collect(provider: ScriptedTestProvider, request: CompletionRequest):
    return [event async for event in provider.stream(request)]


class TestDemoScriptDrivesContractChain:
    async def test_algorithm_designer_full_demo_turns(self) -> None:
        """§10 第 1/2 条：首轮文本 + 3 次工具调用（circuit/counts/submit_task）。"""
        provider = ScriptedTestProvider()
        turn1 = await collect(provider, request_for("algorithm-designer", "run-1"))
        texts = "".join(e.text for e in turn1 if isinstance(e, TextDelta))
        assert "VQE" in texts
        calls = [e for e in turn1 if isinstance(e, ToolCall)]
        assert [c.name for c in calls] == [
            "emit_artifact", "emit_artifact", "submit_task",
        ]
        assert turn1[-1] == TurnCompleted("tool_use")
        # 收束轮
        turn2 = await collect(provider, request_for("algorithm-designer", "run-1"))
        assert turn2[-1] == TurnCompleted("stop")
        assert any(isinstance(e, TextDelta) for e in turn2)

    async def test_demo_artifacts_pass_validation(self) -> None:
        """不变量：剧本产物载荷满足契约 §6 全部约束（生成侧自证）。"""
        artifacts = default_demo_artifacts()
        validate_artifact_payload("circuit", artifacts["circuit"])
        validate_artifact_payload("counts", artifacts["counts"])
        validate_artifact_payload("waveform", artifacts["waveform"])

    async def test_demo_task_steps_pass_dag_validation(self) -> None:
        """不变量：剧本 3 步 DAG 满足提交期校验（3 步链式）。"""
        specs = [
            StepSpec(name="分子积分计算", kind="classical"),
            StepSpec(name="VQE 线路执行", kind="quantum", depends_on=[0]),
            StepSpec(name="结果后处理", kind="classical", depends_on=[1]),
        ]
        validate_step_specs(specs)

    async def test_tool_arguments_are_valid_json(self) -> None:
        provider = ScriptedTestProvider()
        events = await collect(provider, request_for("calibration", "run-2"))
        for event in events:
            if isinstance(event, ToolCall):
                parsed = json.loads(event.arguments)  # 非法 JSON 会直接抛错
                assert isinstance(parsed, dict)

    async def test_calibration_emits_waveform(self) -> None:
        provider = ScriptedTestProvider()
        events = await collect(provider, request_for("calibration", "run-3"))
        call = next(e for e in events if isinstance(e, ToolCall))
        assert call.name == "emit_artifact"
        assert json.loads(call.arguments)["artifact"]["type"] == "waveform"


class TestScriptSemantics:
    async def test_run_key_isolation(self) -> None:
        """不同 run_key 的游标互不干扰（并发会话不串台）。"""
        provider = ScriptedTestProvider()
        first = await collect(provider, request_for("algorithm-designer", "run-a"))
        other = await collect(provider, request_for("algorithm-designer", "run-b"))
        # 两个不同 run 都拿到剧本第一轮
        assert any(isinstance(e, ToolCall) for e in first)
        assert any(isinstance(e, ToolCall) for e in other)

    async def test_exhausted_script_falls_back(self) -> None:
        provider = ScriptedTestProvider()
        for _ in range(2):
            await collect(provider, request_for("algorithm-designer", "run-c"))
        third = await collect(provider, request_for("algorithm-designer", "run-c"))
        assert third[-1] == TurnCompleted("stop")  # 回退文本仍正常收束

    async def test_unknown_agent_falls_back(self) -> None:
        provider = ScriptedTestProvider()
        events = await collect(provider, request_for("mystery-agent", "run-d"))
        assert events[-1] == TurnCompleted("stop")

    async def test_echo_agent_repeats_last_user_message(self) -> None:
        provider = ScriptedTestProvider()
        request = CompletionRequest(
            model="scripted-demo",
            messages=[
                {"role": "user", "content": "第一条"},
                {"role": "assistant", "content": "已收到"},
                {"role": "user", "content": "请重复这句话"},
            ],
            metadata={"agent_id": "echo", "run_key": "run-e"},
        )
        events = await collect(provider, request)
        deltas = [e.text for e in events if isinstance(e, TextDelta)]
        assert deltas == ["请重复这句话"]
        assert events[-1] == TurnCompleted("stop")

    async def test_error_injection(self) -> None:
        """负样本：注入式故障 → ProviderErrorEvent，且无 TurnCompleted。"""
        provider = ScriptedTestProvider(
            scripts={"agent": [[("text", "先说一句"), ("error", "注入故障")]]}
        )
        events = await collect(provider, request_for("agent", "run-f"))
        assert any(isinstance(e, TextDelta) for e in events)
        assert events[-1] == ProviderErrorEvent("注入故障")
        assert not any(isinstance(e, TurnCompleted) for e in events)
