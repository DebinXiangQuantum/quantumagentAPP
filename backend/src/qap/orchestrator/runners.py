"""步骤执行器（模拟）：调度器与真实执行环境之间的接缝。

原型阶段所有步骤都是**模拟执行**（零真实硬件/算力依赖，契约 §10 第 5 条）；
按 kind 给出不同的缺省时长（秒，工程选择：让演示动画可感知但不超过耐心），
量子步最慢、经典步最快。接缝保留：未来替换为真实 runner 时调度器零改动。
时长可用环境变量 ``QAP_SIM_STEP_SECONDS`` 全局缩放（演示/测试加速），
或由 Scheduler 注入自定义 runner 完全接管。
"""

from __future__ import annotations

import asyncio
import os

from qap.domain.models import Step

#: 各 kind 的缺省模拟时长（秒）
DEFAULT_DURATION_BY_KIND: dict[str, float] = {
    "classical": 0.20,
    "quantum": 0.45,
    "agent": 0.30,
}
#: 时长缩放环境变量的下界（防止配置成 0/负值让演示失去时间维度）
_MIN_SCALE = 0.0


def _scale_from_env() -> float:
    """读 QAP_SIM_STEP_SECONDS 缩放系数；缺失/非法时回退 1.0。"""
    raw = os.environ.get("QAP_SIM_STEP_SECONDS")
    if raw is None:
        return 1.0
    try:
        value = float(raw)
    except ValueError:
        return 1.0
    if value != value or value in (float("inf"), float("-inf")) or value < _MIN_SCALE:
        return 1.0
    return value


async def simulate_step(step: Step) -> str:
    """模拟执行一个步骤：睡对应时长，返回人类可读的执行说明。

    失败行为：永不主动失败（超时/无节点由调度器判定）；取消由 asyncio
    任务取消语义传播（CancelledError 原样上抛）。
    """
    duration = DEFAULT_DURATION_BY_KIND.get(step.kind, 0.20) * _scale_from_env()
    await asyncio.sleep(duration)
    return f"simulated {step.kind} execution of {step.name!r} ({duration:.2f}s)"


async def never_finish_step(step: Step) -> str:
    """永不完成的执行器（负样本测试：步骤超时路径专用）。"""
    await asyncio.Event().wait()  # 永远阻塞，直到被取消
    raise AssertionError("unreachable")  # pragma: no cover
