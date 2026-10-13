"""组装根：AppConfig → 全部运行时服务的单例容器（依赖注入的交汇点）。

设计约束：所有服务在**应用启动时**构造一次（fail-fast 于 lifespan），
路由层经 ``request.app.state.qap`` 取用；测试可绕过 FastAPI 直接
``build_app_state(config)`` 组装（见 tests/test_runtime.py 的 Rig）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from qap.agents.plugins import PluginRegistry
from qap.agents.providers.base import LLMProvider
from qap.agents.providers.factory import create_provider
from qap.agents.runtime import AgentRuntime
from qap.agents.tools import PlatformTools
from qap.core.config import AppConfig
from qap.core.ids import IdGenerator
from qap.domain.store import ConversationStore, MessageStore, TaskStore
from qap.events.bus import EventBus
from qap.hardware.allocator import Allocator
from qap.hardware.registry import NodeRegistry
from qap.hardware.simulator import UtilizationSimulator
from qap.orchestrator.scheduler import Scheduler
from qap.tenancy.service import TenantService


@dataclass
class AppState:
    """平台全部有状态服务的容器（单进程内存态）。"""

    config: AppConfig
    idgen: IdGenerator
    events: EventBus
    conversations: ConversationStore
    messages: MessageStore
    tasks: TaskStore
    tenants: TenantService
    plugins: PluginRegistry
    nodes: NodeRegistry
    allocator: Allocator
    scheduler: Scheduler
    simulator: UtilizationSimulator
    runtime: AgentRuntime
    #: 进行中的 Agent 运行（run_id -> asyncio.Task；关闭时兜底取消）
    runs: dict[str, object] = field(default_factory=dict)

    def spawn_run(self, run_id: str, coroutine) -> None:
        """登记并启动一次后台 Agent 运行。"""
        self.runs[run_id] = _spawn(coroutine)

    # ---------- 领域对象工厂（路由层共用，保证 id/时间戳一致） ----------

    def new_conversation(self, agent_id: str, title: str, tenant_id: str) -> "Conversation":
        """创建会话领域对象（id = c-N）。"""
        from qap.core.clock import utcnow_iso
        from qap.domain.models import Conversation

        return Conversation(
            id=self.idgen.next("c"),
            title=title,
            agent_id=agent_id,
            tenant_id=tenant_id,
            created_at=utcnow_iso(),
        )

    def new_message(
        self, conversation_id: str, role: str, content: str, agent_id: str
    ) -> "Message":
        """创建消息领域对象（id = m-N）。"""
        from qap.core.clock import utcnow_iso
        from qap.domain.models import Message

        return Message(
            id=self.idgen.next("m"),
            conversation_id=conversation_id,
            role=role,
            content=content,
            agent_id=agent_id,
            created_at=utcnow_iso(),
        )

    async def shutdown(self) -> None:
        """优雅关停：模拟器停止 + 未完成运行取消。"""
        await self.simulator.stop()
        for task in list(self.runs.values()):
            task.cancel()


def _spawn(coroutine):
    """create_task 的薄封装（集中 try 语义，避免散落）。"""
    import asyncio

    return asyncio.get_running_loop().create_task(coroutine)


def build_app_state(config: AppConfig) -> AppState:
    """从已校验配置组装全部服务（构造顺序即依赖顺序）。

    利用率模拟器是否启动由 ``main.py`` 的 lifespan 按
    ``config.hardware.simulated`` 决定（测试常关）。
    """
    idgen = IdGenerator()
    events = EventBus()
    conversations = ConversationStore()
    messages = MessageStore()
    tasks = TaskStore()
    tenants = TenantService(config.tenancy)
    plugins = PluginRegistry(config.agents)
    nodes = NodeRegistry(config.hardware)
    allocator = Allocator(nodes, events)

    def on_task_finished(task) -> None:
        """任务终态 → 释放租户并发额度（S3 回调接缝的落点）。"""
        tenants.release_task(task.tenant_id, task.id)

    scheduler = Scheduler(
        config.scheduler, allocator, events, on_task_finished=on_task_finished
    )
    simulator = UtilizationSimulator(nodes, events, config.hardware.tick_seconds)
    tools = PlatformTools(idgen, tenants, scheduler, tasks, nodes.snapshot)

    # Provider 表：model_ref → provider 实例（mock 共享剧本游标，天然单例）
    providers: dict[str, LLMProvider] = {
        ref: create_provider(entry) for ref, entry in config.models.items()
    }
    runtime = AgentRuntime(plugins, lambda model_ref: providers[model_ref], tools, events)
    return AppState(
        config=config,
        idgen=idgen,
        events=events,
        conversations=conversations,
        messages=messages,
        tasks=tasks,
        tenants=tenants,
        plugins=plugins,
        nodes=nodes,
        allocator=allocator,
        scheduler=scheduler,
        simulator=simulator,
        runtime=runtime,
    )
