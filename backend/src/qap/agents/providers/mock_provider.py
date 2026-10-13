"""Mock Provider：脚本化驱动 §10 端到端演示链路（进程内、零网络）。

脚本模型：
- 每个 agent_id 一个**剧本**（script），剧本是"轮"（turn）的列表——
  Runtime 工具循环每轮调用一次 ``stream``，mock 用 ``run_key``
  （会话+消息级唯一，由 Runtime 放进 metadata）推进剧本游标；
- 每轮是若干**脚本项**：``("text", str)`` 正文增量、
  ``("thought", str)`` 思考增量（v1.1：产出 ThoughtDelta，演示
  message.reasoning 链路）、``("tool", name, arguments_dict)`` 完整工具
  调用、``("error", message)`` 注入式故障（负样本测试用）；
- 剧本耗尽后回退为一句固定文本（保证任何额外轮次仍能正常收束）；
- ``echo`` agent 特殊处理：首轮原样返回最后一条用户消息（回声演示）。

v1.1 思考程度语义：mock **忽略但记录**——每次 ``stream`` 把
``(run_key, thinking_level)`` 追加进 ``request_log``（测试可观察），
不改变事件行为。

默认剧本内置 §10 验收基线所需的全部可观察行为：
思考流 → 文本流 → emit_artifact(circuit) → emit_artifact(counts) →
submit_task(3 步 DAG) → 收束文本。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from qap.agents.providers.base import (
    CompletionRequest,
    ProviderErrorEvent,
    ProviderEvent,
    TextDelta,
    ThoughtDelta,
    ToolCall,
    TurnCompleted,
)

#: Bell 态线路（契约 §6 示例样例，演示用）
_DEMO_CIRCUIT = {
    "qubits": 2,
    "operations": [
        {"id": "op-0", "gate": "H", "targets": [0]},
        {"id": "op-1", "gate": "CNOT", "controls": [0], "targets": [1]},
        {"id": "op-2", "gate": "MEASURE", "targets": [0, 1]},
    ],
}

#: 计数守恒的演示直方图（sum == shots，比特串长度 == qubits）
_DEMO_COUNTS = {
    "shots": 1024,
    "qubits": 2,
    "counts": {"00": 498, "11": 512, "01": 8, "10": 6},
}

#: 校准演示波形（高斯包络，长度 8 ∈ [2,65536]，全有限）
_DEMO_WAVEFORM = {
    "sample_rate_ns": 1.0,
    "unit": "mV",
    "channels": [
        {"label": "Q0 I", "samples": [0.0, 0.31, 0.71, 0.95, 0.95, 0.71, 0.31, 0.0]},
        {"label": "Q0 Q", "samples": [0.0, 0.05, 0.12, 0.20, 0.12, 0.05, 0.01, 0.0]},
    ],
}

#: §10 第 2 条：3 步链式 DAG（分子积分 → VQE 线路执行 → 结果后处理）
_DEMO_TASK_STEPS = [
    {"name": "分子积分计算", "kind": "classical"},
    {"name": "VQE 线路执行", "kind": "quantum", "depends_on": [0]},
    {"name": "结果后处理", "kind": "classical", "depends_on": [1]},
]

#: 默认剧本：agent_id → 轮列表（见模块 docstring）
DEFAULT_SCRIPTS: dict[str, list[list[tuple]]] = {
    "algorithm-designer": [
        [
            ("thought", "分析：先把化学问题映射为分子哈密顿量的矩阵表示。"),
            ("thought", "再选择参数化拟设与测量基组，估算采样预算。"),
            ("text", "我来设计一个 VQE（变分量子本征求解器）方案："),
            ("text", "先构造 Bell 态线路做参数化基线，再以 1024 shots 采样。"),
            ("tool", "emit_artifact", {"artifact": {"type": "circuit", "title": "VQE 基线线路", "payload": _DEMO_CIRCUIT}}),
            ("tool", "emit_artifact", {"artifact": {"type": "counts", "title": "1024 shots 测量计数", "payload": _DEMO_COUNTS}}),
            ("text", "接下来把全流程提交为 3 步任务（分子积分 → VQE 执行 → 后处理）。"),
            ("tool", "submit_task", {"name": "VQE 全流程", "steps": _DEMO_TASK_STEPS}),
        ],
        [
            ("text", "线路与计数产物已附上，3 步任务已提交调度，可在任务面板观察执行进度。"),
        ],
    ],
    "calibration": [
        [
            ("text", "正在读取最近的校准数据，生成 Q0 的 DRAG 修正波形。"),
            ("tool", "emit_artifact", {"artifact": {"type": "waveform", "title": "Q0 DRAG 波形", "payload": _DEMO_WAVEFORM}}),
        ],
        [
            ("text", "波形已生成；如需进一步扫幅/扫宽请继续说明。"),
        ],
    ],
}

#: 剧本耗尽时的回退文本（保证任何轮次都能正常收束）
_FALLBACK_TEXT = "（mock 剧本已耗尽——这是一条收束文本。）"


class MockProvider:
    """内置脚本化 Provider；可通过注入 scripts 覆盖默认演示剧本。

    ``request_log``：每次 stream 记录 ``{"run_key", "agent_id",
    "thinking_level"}``（v1.1：mock 忽略思考程度但记录，供测试断言
    取值优先级），append-only、无清理（原型内存态）。
    """

    def __init__(self, scripts: dict[str, list[list[tuple]]] | None = None) -> None:
        self._scripts = scripts if scripts is not None else DEFAULT_SCRIPTS
        self._cursors: dict[str, int] = {}  # run_key → 已消费的轮数
        self.request_log: list[dict[str, Any]] = []

    # ---------- 对外接口 ----------

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        run_key = str(request.metadata.get("run_key", "anonymous"))
        agent_id = str(request.metadata.get("agent_id", ""))
        self.request_log.append(
            {
                "run_key": run_key,
                "agent_id": agent_id,
                "thinking_level": request.thinking_level,
            }
        )
        if agent_id == "echo":
            async for event in self._stream_echo(request):
                yield event
            return
        script = self._scripts.get(agent_id)
        if script is None:  # 未提供剧本 → 回声式收束，避免运行时死循环
            yield TextDelta(_FALLBACK_TEXT)
            yield TurnCompleted("stop")
            return
        turn_index = self._cursors.get(run_key, 0)
        self._cursors[run_key] = turn_index + 1
        turn = script[turn_index] if turn_index < len(script) else [("text", _FALLBACK_TEXT)]
        had_tool = False
        for item in turn:
            # 每项之间让出控制权：模拟真实流式节奏，也让 SSE 消费端实时可见
            await asyncio.sleep(0)
            kind = item[0]
            if kind == "text":
                yield TextDelta(item[1])
            elif kind == "thought":
                yield ThoughtDelta(item[1])
            elif kind == "tool":
                had_tool = True
                yield ToolCall(item[1], json.dumps(item[2], ensure_ascii=False))
            elif kind == "error":
                yield ProviderErrorEvent(item[1])
                return  # 错误后流终止，不发 TurnCompleted
            else:  # pragma: no cover - 剧本由本仓库维护，未知项防御性终止
                yield ProviderErrorEvent(f"mock: unknown script item kind {kind!r}")
                return
        yield TurnCompleted("tool_use" if had_tool else "stop")

    # ---------- 内部 ----------

    async def _stream_echo(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        """echo agent：原样返回最后一条用户消息（无剧本、无工具）。"""
        last_user = next(
            (
                message["content"]
                for message in reversed(request.messages)
                if message.get("role") == "user"
            ),
            "",
        )
        await asyncio.sleep(0)
        yield TextDelta(str(last_user))
        yield TurnCompleted("stop")


def default_demo_artifacts() -> dict[str, Any]:
    """返回演示剧本使用的三个产物载荷（集成测试/前端联调便捷入口）。"""
    return {
        "circuit": _DEMO_CIRCUIT,
        "counts": _DEMO_COUNTS,
        "waveform": _DEMO_WAVEFORM,
    }
