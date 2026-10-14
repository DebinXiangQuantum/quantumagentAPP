"""利用率与 metrics 模拟器：周期性驱动各节点（契约 §3/§4 v1.2）。

利用率模型（工程选择，非硬件观测）：
- 目标利用率与负载相关：``target = 0.15 + 0.75 * load_ratio``，
  其中 load_ratio = 活动租约/capacity（空闲 ≈ 0.15，满载 ≈ 0.90）；
- 实际值向目标一阶惯性逼近并叠加 ±0.05 噪声（模拟测量抖动），
  最后 clamp 到 [0.05, 0.98]——**构造上**保证不变量 3，无需事后修复；
- 仅当至少一个节点数值发生变化时发布 ``hardware.updated``（契约 §7
  "利用率/分配变化时推送"），避免无意义的重复帧。

metrics 漂移（v1.2 §4，simulated 非硬件观测）：QPU 保真度每 tick
±0.0002 随机游走 clamp (0,1]；CPU/GPU used 值随机游走 clamp [0,total]
（漂移构造见 hardware/metrics.py，不变量可由 domain/invariants.py 复核）。
确定性：注入 ``rng``（``random.Random``）即可复现，测试不依赖真实随机。
"""

from __future__ import annotations

import asyncio
import random

from qap.domain.models import HardwareNode
from qap.events.bus import EventBus
from qap.hardware.metrics import drift_node_metrics
from qap.hardware.registry import NodeRegistry

#: 空闲基线 / 满载目标 / 噪声幅度 / clamp 上下界（见模块 docstring）
IDLE_UTILIZATION = 0.15
FULL_UTILIZATION = 0.90
NOISE_AMPLITUDE = 0.05
UTILIZATION_MIN = 0.05
UTILIZATION_MAX = 0.98
#: 事件循环里 stop() 后等待 run() 退出的宽限
_SHUTDOWN_GRACE_SECONDS = 1.0


class UtilizationSimulator:
    """后台 tick 循环；``run()`` 由应用 lifespan 启动，``stop()`` 收尾。"""

    def __init__(
        self,
        registry: NodeRegistry,
        events: EventBus,
        tick_seconds: float,
        *,
        rng: random.Random | None = None,
    ) -> None:
        if tick_seconds <= 0 or tick_seconds != tick_seconds:
            raise ValueError("tick_seconds must be a positive finite number")
        self._registry = registry
        self._events = events
        self._tick_seconds = tick_seconds
        self._rng = rng or random.Random()
        self._task: asyncio.Task | None = None

    # ---------- 生命周期 ----------

    def start(self) -> None:
        """以后台任务方式启动 tick 循环（幂等）。"""
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._run_guarded())

    async def stop(self) -> None:
        """请求停止并等待退出（幂等；超时则取消）。"""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await asyncio.wait_for(self._task, timeout=_SHUTDOWN_GRACE_SECONDS)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        finally:
            self._task = None

    async def _run_guarded(self) -> None:
        """tick 循环的防崩壳：异常不应杀死整个循环（可观察性优先）。"""
        while True:
            await asyncio.sleep(self._tick_seconds)
            try:
                self.tick()
            except Exception:  # pragma: no cover - 模型校验已保证合法值
                continue

    # ---------- 单步 ----------

    def tick(self) -> bool:
        """推进一拍（利用率 + metrics 漂移）并按需发布事件；返回是否发布。

        v1.2：metrics 同拍漂移——QPU 保真度 ±0.0002 随机游走 clamp (0,1]，
        CPU/GPU used 值随机游走 clamp [0,total]（T1/T2 静态规格）；
        构造性满足 §4 v1.2 不变量（domain.invariants 可复核）。
        v1.4：只作用于 ``simulated_ids()``（config 手写节点）——logicalcloud
        实拉的 lq-* 节点利用率无云端数据 → 恒 0 不漂移（诚实降级，
        绝不伪造监控数值）。
        """
        changed = False
        for node_id in self._registry.simulated_ids():
            node = self._registry.get(node_id)
            new_value = self._next_utilization(node)
            if new_value != node.utilization:
                self._registry.set_utilization(node_id, new_value)
                changed = True
            if node.metrics is not None:
                drifted = drift_node_metrics(node.kind, node.metrics, self._rng)
                if drifted != node.metrics:
                    self._registry.set_metrics(node_id, drifted)
                    changed = True
        if changed:
            self._events.publish(
                "hardware.updated",
                {"nodes": [n.model_dump() for n in self._registry.snapshot()]},
            )
        return changed

    def _next_utilization(self, node: HardwareNode) -> float:
        """按负载模型计算该节点下一拍利用率（构造性 ∈ [0.05,0.98]）。"""
        load_ratio = len(node.allocations) / node.capacity
        target = IDLE_UTILIZATION + (FULL_UTILIZATION - IDLE_UTILIZATION) * load_ratio
        noise = self._rng.uniform(-NOISE_AMPLITUDE, NOISE_AMPLITUDE)
        approached = node.utilization + 0.6 * (target - node.utilization) + noise
        clamped = min(UTILIZATION_MAX, max(UTILIZATION_MIN, approached))
        # 保留 3 位小数：避免浮点噪声导致"数值总在变"的重复事件帧。
        return round(clamped, 3)
