"""V4 内置专家真实化测试（契约 §8 v1.4；v1.6 去 mock 化修订）。

四类场景：
- 不变量：三个内置专家提示为**通用领域提示**——algorithm-designer 含
  "选择算法"（不预设 VQE 剧本）与经典-量子混合建模（MIP/QUBO）；
  calibration 面向校准数据→波形修正；orchestrator 保持自主调度且强调
  "真实执行/勿编造结果"。
- 非法输入拒绝：（提示重写后）演示剧本仍只覆盖端到端链路——剧本未覆盖
  的 agent 请求 → 测试替身返回单条"[scripted provider]"明确说明，
  不产出看似真实的推理模板（替身诚实护栏）。
- 负样本：algorithm-designer 提示不含写死的 VQE 剧本文案（"分子积分"
  "变分量子本征求解器"等演示链路话术）。
- 可观察行为：命中剧本的端到端链路保持（orchestrator 首轮仍产出
  dispatch_agent 工具调用；algorithm-designer 首轮仍产出
  emit_artifact/submit_task）——由 tests/scripted_provider.py 替身驱动。
"""

from __future__ import annotations

import json

from qap.agents.plugins import BUILTIN_PLUGINS, ORCHESTRATOR_ID, PluginRegistry
from qap.agents.providers.base import CompletionRequest, TextDelta, ToolCall, TurnCompleted
from qap.core.config import AgentsConfig, BuiltinAgentConfig
from tests.scripted_provider import ScriptedTestProvider


def registry() -> PluginRegistry:
    """内置四件套注册表（default 模型绑定）。"""
    return PluginRegistry(
        AgentsConfig(
            default_model_ref="default",
            plugins_dir="",
            builtin={
                "algorithm-designer": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "calibration": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "echo": BuiltinAgentConfig(enabled=True, model_ref="default"),
                ORCHESTRATOR_ID: BuiltinAgentConfig(enabled=True, model_ref="default"),
            },
        )
    )


def prompt_of(agent_id: str) -> str:
    return registry().get(agent_id).system_prompt


async def collect(provider: ScriptedTestProvider, *, agent_id: str, run_key: str,
                  prompt: str = "演示输入") -> list:
    """跑一轮替身流并收集事件。"""
    events = []
    request = CompletionRequest(
        model="default",
        messages=[{"role": "user", "content": prompt}],
        system=None,
        metadata={"run_key": run_key, "agent_id": agent_id},
    )
    async for event in provider.stream(request):
        events.append(event)
    return events


class TestExpertPromptsRealInference:
    def test_algorithm_designer_is_generic_domain_prompt(self) -> None:
        """通用工作流：问题分析→量子适用性→建模（含 MIP/QUBO）→**选择
        算法**→合成线路（circuit + submit_task 带 circuit/shots）→解读
        真实结果。"""
        prompt = prompt_of("algorithm-designer")
        assert "选择算法" in prompt
        assert "QUBO" in prompt or "MIP" in prompt
        assert "emit_artifact" in prompt and "circuit" in prompt
        assert "submit_task" in prompt and "shots" in prompt
        assert "真实" in prompt

    def test_algorithm_designer_drops_vqe_script_wording(self) -> None:
        """不再绑定 VQE 演示剧本话术（负样本断言）。"""
        prompt = prompt_of("algorithm-designer")
        for banned in ("分子积分", "变分量子本征求解器", "VQE 基线",
                       "先构造 Bell 态线路"):
            assert banned not in prompt, f"prompt still contains {banned!r}"

    def test_calibration_prompt_targets_waveform_correction(self) -> None:
        """校准专家：校准数据→波形修正（waveform artifact）。"""
        prompt = prompt_of("calibration")
        assert "校准" in prompt
        assert "waveform" in prompt
        assert "emit_artifact" in prompt
        assert "修正" in prompt or "校正" in prompt

    def test_orchestrator_prompt_keeps_dispatch_and_demands_honesty(self) -> None:
        """编排提示：专家清单/平台工具保持，并强调真实执行、勿编造。"""
        prompt = prompt_of(ORCHESTRATOR_ID)
        assert "algorithm-designer" in prompt and "calibration" in prompt
        assert "dispatch_agent" in prompt
        assert "真实" in prompt
        assert "编造" in prompt or "虚构" in prompt

    def test_echo_prompt_unchanged_semantics(self) -> None:
        """echo 保持最小演示语义（回声）。"""
        assert "原样" in prompt_of("echo")


class TestScriptedHonesty:
    """测试替身诚实护栏（自原 mock 诚实化语义移植）：剧本未覆盖的 agent
    → 单条明确说明，不产出看似真实的推理模板（缺剧本一眼可见）。"""

    async def test_uncovered_agent_returns_honest_notice(self) -> None:
        provider = ScriptedTestProvider()
        events = await collect(provider, agent_id="custom-expert", run_key="r-1")
        texts = [e for e in events if isinstance(e, TextDelta)]
        tools = [e for e in events if isinstance(e, ToolCall)]
        assert len(texts) == 1
        assert tools == []
        assert texts[0].text.startswith("[scripted provider]")
        assert "剧本未覆盖" in texts[0].text
        assert any(isinstance(e, TurnCompleted) for e in events)

    async def test_uncovered_request_stays_single_shot_on_repeat(self) -> None:
        """重复轮次依旧单条说明（无状态推进、不演双簧）。"""
        provider = ScriptedTestProvider()
        first = await collect(provider, agent_id="custom-expert", run_key="r-2")
        second = await collect(provider, agent_id="custom-expert", run_key="r-2")
        text_of = lambda evs: next(e.text for e in evs if isinstance(e, TextDelta))
        assert text_of(first) == text_of(second)
        assert text_of(second).startswith("[scripted provider]")


class TestDemoScriptsPreserved:
    async def test_orchestrator_demo_script_still_dispatches(self) -> None:
        """命中剧本：orchestrator 首轮仍产出 dispatch_agent 工具调用。"""
        provider = ScriptedTestProvider()
        events = await collect(provider, agent_id=ORCHESTRATOR_ID,
                               run_key="demo-1", prompt="帮我设计一个 VQE 方案")
        tools = [e for e in events if isinstance(e, ToolCall)]
        assert any(t.name == "dispatch_agent" for t in tools)

    async def test_algorithm_designer_demo_script_still_emits_and_submits(self) -> None:
        """命中剧本：algorithm-designer 首轮仍产出 emit_artifact ×2 +
        submit_task（端到端链路依赖保持）。"""
        provider = ScriptedTestProvider()
        events = await collect(provider, agent_id="algorithm-designer",
                               run_key="demo-2", prompt="设计一个 VQE 方案")
        tools = [e for e in events if isinstance(e, ToolCall)]
        names = [t.name for t in tools]
        assert names.count("emit_artifact") == 2
        assert "submit_task" in names
        submit = next(t for t in tools if t.name == "submit_task")
        arguments = json.loads(submit.arguments)
        assert len(arguments["steps"]) == 3
