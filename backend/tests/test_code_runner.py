"""classical 代码分发执行链（v1.7）：调度器 → 节点 worker → 结果回流。

真实执行语义：代码在节点 worker 的子进程里真跑（本测试以 ASGI 直连
worker 应用模拟节点机器——部署时为真实远程端点）；后端只分发。
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from qap.compute.node_worker import create_worker_app
from qap.core.ids import IdGenerator
from qap.domain.store import TaskStore
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import build_node_registry
from qap.orchestrator.code_runner import CodeDispatchRunner
from qap.orchestrator.dag import StepSpec, build_steps
from qap.orchestrator.scheduler import Scheduler
from qap.core.config import HardwareConfig, HardwareNodeConfig, SchedulerConfig


def make_config(exec_url: str | None) -> HardwareConfig:
    return HardwareConfig(
        provider="simulated",
        simulated=True,
        tick_seconds=60.0,
        nodes=[
            HardwareNodeConfig(
                id="cpu-0", kind="cpu", name="CPU0", model="m", capacity=4,
                cpu_cores=8, memory_total_gb=16.0, exec_url=exec_url,
            ),
        ],
    )


def make_client_factory():
    """每个 exec_url 一个 ASGI 直连客户端（worker 应用即"节点机器"）。"""
    apps: dict[str, httpx.AsyncClient] = {}

    def factory(url: str):
        if url not in apps:
            transport = httpx.ASGITransport(app=create_worker_app(node_name="cpu-0"))
            apps[url] = httpx.AsyncClient(transport=transport, base_url=url)
        return _ClientAdapter(apps[url])

    return factory


class _ClientAdapter:
    """把 AsyncClient 适配成 NodeWorkerClient 构造入参形态。"""

    def __init__(self, http: httpx.AsyncClient):
        from qap.compute.worker_client import NodeWorkerClient

        self._inner = NodeWorkerClient(http)

    async def execute(self, code, **kw):
        return await self._inner.execute(code, **kw)


class TestCodeDispatch:
    async def test_code_executes_on_node_and_result_readable(self) -> None:
        registry = build_node_registry(make_config("http://cpu-0-node"))
        bus = EventBus()
        allocator = Allocator(registry, bus)
        scheduler = Scheduler(
            SchedulerConfig(max_parallel_steps=2, step_timeout_seconds=30.0,
                            retry_failed_steps=False),
            allocator, bus,
            runner=CodeDispatchRunner(registry, _fake_fallback(),
                                      client_factory=make_client_factory()),
            poll_interval=0.01,
        )
        tasks = TaskStore()
        from qap.domain.models import Task

        task = Task(
            id="t-1", conversation_id="c-1", tenant_id="demo", name="PCA 预处理",
            steps=build_steps([StepSpec(
                name="numpy-calc", kind="classical",
                workload={"code": "import json\nprint(json.dumps({'pca': 8, 'var': 0.91}))"},
            )], IdGenerator()),
            created_at="2026-10-14T00:00:00Z",
        )
        tasks.add(task)
        done = await scheduler.submit(task, agent_id="algorithm-designer")
        step = done.steps[0]
        assert step.status == "succeeded"
        assert step.node_id == "cpu-0"  # 分发到了计算节点
        result = (step.workload or {}).get("result") or {}
        assert result.get("exit_code") == 0
        assert '"pca": 8' in result.get("stdout", "")
        assert (step.workload or {}).get("node_exec") == "cpu-0"
        assert step.duration_ms and step.duration_ms > 0  # 调度器实测

    async def test_code_failure_fails_step_with_stderr(self) -> None:
        registry = build_node_registry(make_config("http://cpu-0-node"))
        bus = EventBus()
        scheduler = Scheduler(
            SchedulerConfig(max_parallel_steps=2, step_timeout_seconds=30.0,
                            retry_failed_steps=False),
            Allocator(registry, bus), bus,
            runner=CodeDispatchRunner(registry, _fake_fallback(),
                                      client_factory=make_client_factory()),
            poll_interval=0.01,
        )
        from qap.domain.models import Task

        task = Task(
            id="t-2", conversation_id="c-1", tenant_id="demo", name="失败代码",
            steps=build_steps([StepSpec(
                name="bad", kind="classical",
                workload={"code": "raise RuntimeError('pca-marker-fail')"},
            )], IdGenerator()),
            created_at="2026-10-14T00:00:00Z",
        )
        done = await scheduler.submit(task, agent_id="a")
        step = done.steps[0]
        assert step.status == "failed"
        assert "pca-marker-fail" in (step.error or "")

    async def test_no_exec_url_honest_error(self) -> None:
        registry = build_node_registry(make_config(None))  # 未配置执行端点
        bus = EventBus()
        scheduler = Scheduler(
            SchedulerConfig(max_parallel_steps=2, step_timeout_seconds=30.0,
                            retry_failed_steps=False),
            Allocator(registry, bus), bus,
            runner=CodeDispatchRunner(registry, _fake_fallback()),
            poll_interval=0.01,
        )
        from qap.domain.models import Task

        task = Task(
            id="t-3", conversation_id="c-1", tenant_id="demo", name="无端点",
            steps=build_steps([StepSpec(
                name="code", kind="classical", workload={"code": "print(1)"},
            )], IdGenerator()),
            created_at="2026-10-14T00:00:00Z",
        )
        done = await scheduler.submit(task, agent_id="a")
        step = done.steps[0]
        assert step.status == "failed"
        assert "exec_url" in (step.error or "")

    async def test_non_code_classical_falls_through(self) -> None:
        """无 code 的 classical 步 → fallback 既有负载（zlib），互不干扰。"""
        from qap.orchestrator.runners import simulate_step

        registry = build_node_registry(make_config("http://cpu-0-node"))
        runner = CodeDispatchRunner(registry, simulate_step)
        from qap.domain.models import Step

        step = Step(
            id="s-9", name="zlib 步", kind="classical", status="running",
            node_id="cpu-0", depends_on=[], started_at=None, finished_at=None,
            detail="", error=None, workload={"bytes": 4096},
        )
        outcome = await runner(step)
        assert "zlib" in outcome or "roundtrip" in outcome


def _fake_fallback():
    from qap.orchestrator.runners import simulate_step

    return simulate_step
