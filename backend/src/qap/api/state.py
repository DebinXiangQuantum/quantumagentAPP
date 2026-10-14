"""组装根：AppConfig → 全部运行时服务的单例容器（依赖注入的交汇点）。

设计约束：所有服务在**应用启动时**构造一次（fail-fast 于 lifespan），
路由层经 ``request.app.state.qap`` 取用；测试可绕过 FastAPI 直接
``build_app_state(config)`` 组装（见 tests/test_runtime.py 的 Rig）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from qap.agents.plugin_manager import PluginManager
from qap.agents.plugins import PluginRegistry
from qap.agents.providers.base import LLMProvider
from qap.agents.providers.factory import create_provider
from qap.agents.runtime import AgentRuntime
from qap.agents.tools import PlatformTools
from qap.core.config import AppConfig, LoadedConfig
from qap.core.errors import NotFoundError, SchedulingError
from qap.core.ids import IdGenerator
from qap.core.local_store import LOCAL_CONFIG_FILENAME, LocalConfigStore
from qap.domain.attachments import (
    TEXT_INJECTION_CHAR_LIMIT,
    AttachmentStore,
)
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
    #: 附件表（v1.3：内存字节存储；上传/raw/发消息引用三处共用）
    attachments: AttachmentStore
    tenants: TenantService
    plugins: PluginRegistry
    nodes: NodeRegistry
    allocator: Allocator
    scheduler: Scheduler
    simulator: UtilizationSimulator
    runtime: AgentRuntime
    #: 插件安装生命周期管理（admin 端点，v1.1 §8）
    plugin_manager: PluginManager
    #: model_ref → provider 实例（admin 渠道编辑后原地增删改，v1.1 §5）
    providers: dict[str, LLMProvider] = field(default_factory=dict)
    #: config.local.toml 存取（admin 持久化出口；None = 无文件落点）
    local_store: LocalConfigStore | None = None
    #: 基底（config.toml）渠道 refs——不可删除（admin DELETE → 409 判定）
    base_model_refs: frozenset[str] = frozenset()
    #: 进行中的 Agent 运行（run_id -> asyncio.Task；关闭时兜底取消）
    runs: dict[str, object] = field(default_factory=dict)

    def spawn_run(self, run_id: str, coroutine) -> None:
        """登记并启动一次后台 Agent 运行。"""
        self.runs[run_id] = _spawn(coroutine)

    def provider_for(self, model_ref: str) -> LLMProvider:
        """取该渠道的 provider；未配置的 ref 是编程错误（入口已校验）。"""
        try:
            return self.providers[model_ref]
        except KeyError:
            raise NotFoundError("model channel", model_ref) from None

    def default_thinking_for(self, model_ref: str) -> str:
        """渠道默认思考程度（契约 §9 优先级中段；未知 ref 缺省 high）。"""
        entry = self.config.models.get(model_ref)
        return entry.default_thinking if entry is not None else "high"

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


def build_app_state(config: AppConfig | LoadedConfig) -> AppState:
    """从已校验配置组装全部服务（构造顺序即依赖顺序）。

    接受 ``LoadedConfig``（生产路径：含 base/local 溯源与 plugins_dir 根）
    或裸 ``AppConfig``（测试注入：无文件溯源，plugins_dir/local 落点取
    CWD）。利用率模拟器是否启动由 ``main.py`` 的 lifespan 按
    ``config.hardware.simulated`` 决定（测试常关）。
    """
    if isinstance(config, LoadedConfig):
        loaded = config
        app_config = loaded.config
        base_dir = loaded.base_path.parent
    else:
        app_config = config
        base_dir = Path.cwd()
        loaded = None
    idgen = IdGenerator()
    events = EventBus()
    conversations = ConversationStore()
    messages = MessageStore()
    tasks = TaskStore()
    attachments = AttachmentStore()
    tenants = TenantService(app_config.tenancy)
    plugins = PluginRegistry(app_config.agents, base_dir=base_dir)
    nodes = NodeRegistry(app_config.hardware)
    allocator = Allocator(nodes, events)

    def on_task_finished(task) -> None:
        """任务终态 → 释放租户并发额度（S3 回调接缝的落点）。"""
        tenants.release_task(task.tenant_id, task.id)

    scheduler = Scheduler(
        app_config.scheduler, allocator, events, on_task_finished=on_task_finished
    )
    simulator = UtilizationSimulator(nodes, events, app_config.hardware.tick_seconds)
    tools = PlatformTools(idgen, tenants, scheduler, tasks, nodes.snapshot)

    # Provider 表：model_ref → provider 实例（mock 共享剧本游标，天然单例）。
    # 存于 providers dict 并挂到 state：admin 渠道编辑（v1.1 §5）原地增删改。
    providers: dict[str, LLMProvider] = {
        ref: create_provider(entry) for ref, entry in app_config.models.items()
    }
    def attachment_parts(message) -> list:
        """带附件的 user 消息 → AttachmentPart 序列（v1.3 §5/§9）。

        text：UTF-8 解码并截断 200k 字符（替换非法字节）；image：base64；
        file：仅元数据（provider 侧只标注不注入）。附件记录丢失（重启后
        内存态清空等）时跳过该附件——消息里的 meta 仍保留展示。
        """
        import base64 as _base64

        from qap.agents.providers.base import AttachmentPart

        parts = []
        for meta in message.attachments:
            record = attachments._items.get(meta.id)  # noqa: SLF001 - 同组装根
            if record is None or record.conversation_id != message.conversation_id:
                continue
            if meta.kind == "text":
                text = record.data.decode("utf-8", errors="replace")
                parts.append(
                    AttachmentPart(
                        id=meta.id, name=meta.name, mime=meta.mime, kind="text",
                        text=text[:TEXT_INJECTION_CHAR_LIMIT],
                    )
                )
            elif meta.kind == "image":
                parts.append(
                    AttachmentPart(
                        id=meta.id, name=meta.name, mime=meta.mime, kind="image",
                        data_base64=_base64.b64encode(record.data).decode("ascii"),
                    )
                )
            else:
                parts.append(
                    AttachmentPart(id=meta.id, name=meta.name, mime=meta.mime, kind="file")
                )
        return parts

    runtime = AgentRuntime(
        plugins,
        # 闭包与 state.providers 共享同一 dict：admin 渠道增删改即时生效
        lambda model_ref: providers[model_ref],
        tools,
        events,
        default_thinking_for=lambda ref: app_config.models[ref].default_thinking
        if ref in app_config.models
        else "high",
        attachment_resolver=attachment_parts,
    )
    tools.bind_dispatcher(runtime.run_subagent)  # dispatch_agent 执行器（§8）

    async def execute_agent_step(task, step) -> str:
        """agent 步的子运行执行器（v1.3：时长=子运行真实总时长，measured）。

        - 目标专家与指令来自步规格 ``workload.{agent_id, instruction}``
          （缺省 echo + 步名，保证任何 agent 步都有真实子运行）；
        - **一次一层**：dispatch 子运行内提交的任务（``_submit_depth ≥ 1``）
          其 agent 步不可再分派 → 该步失败（诚实报错，不静默降级）；
        - 子运行期间子 Agent 经 submit_task 提交的任务自动挂
          ``step.subtask_id``（step_context 运行时上下文）；
        - 子运行产物（emit_artifact）无消息锚点，仅计入运行即弃——
          agent 步的可观察输出是 detail 与 subtask 链接；
        - 内存不可得（跨多个 await 的真实子运行，tracemalloc 无法归因）
          → ``peak_memory_mb`` 保持 null（契约语义）。
        """
        from qap.agents.plugins import ORCHESTRATOR_ID
        from qap.agents.tools import ToolContext
        from qap.orchestrator.step_context import dispatch_step_scope

        if task._submit_depth >= 1:
            raise SchedulingError(
                f"nested dispatch not allowed: task {task.id!r} was submitted "
                "during a dispatch sub-run (depth=1); its agent steps cannot "
                "dispatch again"
            )
        workload = dict(step.workload or {})
        agent_id = str(workload.get("agent_id") or "echo")
        instruction = str(workload.get("instruction") or step.name)
        parent = ToolContext(
            conversation_id=task.conversation_id,
            tenant_id=task.tenant_id,
            agent_id=ORCHESTRATOR_ID,
            message_id="m-0",  # 影子锚点：子运行不落库不推 SSE（run_subagent 语义）
            run_key=f"{task.id}:{step.id}",
        )
        with dispatch_step_scope(step):
            result = await runtime.run_subagent(parent, agent_id, instruction)
        if "error" in result:
            raise SchedulingError(
                f"dispatch_agent {agent_id!r} failed: "
                f"{result.get('error')}: {result.get('message')}"
            )
        reply = str(result.get("reply") or "")
        return (
            f"dispatch_agent {agent_id!r} sub-run completed (measured): {reply[:160]}"
        )

    scheduler.bind_agent_executor(execute_agent_step)

    # 插件管理：安装目录相对路径以基底配置目录解析；本地覆盖层同目录
    plugins_dir: Path | None = None
    if app_config.agents.plugins_dir.strip():
        candidate = Path(app_config.agents.plugins_dir).expanduser()
        plugins_dir = candidate if candidate.is_absolute() else base_dir / candidate
    local_store = LocalConfigStore(base_dir / LOCAL_CONFIG_FILENAME)
    plugin_manager = PluginManager(plugins, plugins_dir, local_store)
    return AppState(
        config=app_config,
        idgen=idgen,
        events=events,
        conversations=conversations,
        messages=messages,
        tasks=tasks,
        attachments=attachments,
        tenants=tenants,
        plugins=plugins,
        nodes=nodes,
        allocator=allocator,
        scheduler=scheduler,
        simulator=simulator,
        runtime=runtime,
        plugin_manager=plugin_manager,
        providers=providers,
        local_store=local_store,
        base_model_refs=loaded.base_model_refs if loaded else frozenset(app_config.models),
    )
