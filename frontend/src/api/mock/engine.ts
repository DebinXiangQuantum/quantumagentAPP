/**
 * engine.ts —— Mock 引擎：以脚本化事件驱动完整演示链路（ARCHITECTURE §10 + v1.1）。
 *
 * 职责：
 *  - 实现 ApiClient 同一契约（fixtures 初始状态 + 内存可变状态），含 v1.1
 *    管理平台端点（admin models 渠道池 PUT/DELETE、plugins 安装/启停/卸载）；
 *  - sendMessage 触发编排脚本（scripts.ts）：思考增量（message.reasoning，
 *    thinking=off 跳过）→ dispatch 专家 → 流式正文 → completed（含
 *    reasoning 全文 + artifacts）→ DAG 推进 → hardware allocation 变化；
 *  - 会话流带 seq 单调递增（delta 与 reasoning 同源）+ 事件日志（cap 1024）
 *    支持 ?after= 重放；
 *  - 硬件利用率模拟：2s tick 随机游走（对齐 config.toml tick_seconds=2.0）。
 * 失败行为：无网络依赖；畸形输入按 404/409/422 语义抛 ApiError。
 */
import { ApiError, type ApiClient } from '../client';
import type {
  AgentInfo,
  Conversation,
  ConversationDetail,
  HardwareNode,
  HardwareResponse,
  InstallPluginRequest,
  Message,
  ModelChannel,
  ModelChannelInput,
  ModelChannelList,
  PluginInfo,
  PluginList,
  SendMessageAck,
  Task,
  TenantInfo,
  ThinkingLevel,
} from '../../types/domain';
import { parseThinkingLevel } from '../../types/domain';
import type {
  ConversationStreamEvent,
  GlobalStreamEvent,
  StreamCallbacks,
  StreamHandle,
} from '../../types/events';
import {
  ADMIN_MODELS,
  ADMIN_PLUGINS,
  AGENTS,
  BASE_CHANNEL_REFS,
  CONVERSATIONS,
  HARDWARE_NODES,
  MESSAGES_BY_CID,
  TASKS,
  TENANT,
} from './fixtures';
import {
  buildOrchestratorScript,
  type MockScriptContext,
  type TimedAction,
} from './scripts';

/** 会话流日志条目：logSeq 为内部单调序号（delta/reasoning 的 data.seq 与之同源）。 */
interface LoggedEvent {
  logSeq: number;
  evt: ConversationStreamEvent;
}

const EVENT_LOG_CAP = 1024;
const TICK_MS = 2000;

function nowIso(): string {
  return new Date().toISOString();
}

/** 深拷贝（structuredClone 在 Node18+/现代浏览器均可用）。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface MockClient extends ApiClient {
  /** 清理全部定时器（仅测试/热更新需要；正常页面生命周期常驻）。 */
  dispose: () => void;
}

export function createMockClient(): MockClient {
  // —— 可变内存状态（clone fixtures，避免测试间串改常量）——
  const conversations: Conversation[] = clone(CONVERSATIONS);
  const messagesByCid = new Map<string, Message[]>(
    Object.entries(clone(MESSAGES_BY_CID)),
  );
  const tasks: Task[] = clone(TASKS);
  const nodes: HardwareNode[] = clone(HARDWARE_NODES);
  const channels: ModelChannel[] = clone(ADMIN_MODELS);
  const plugins: PluginInfo[] = clone(ADMIN_PLUGINS);

  const convSeq = new Map<string, number>();
  const convLog = new Map<string, LoggedEvent[]>();
  const convSubs = new Map<string, Set<(e: ConversationStreamEvent) => void>>();
  const globalSubs = new Set<(e: GlobalStreamEvent) => void>();

  let idCounter = 100;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const nextId = (prefix: string): string => {
    idCounter += 1;
    return `${prefix}${idCounter}`;
  };
  const schedule = (atMs: number, run: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      run();
    }, atMs);
    timers.add(t);
  };

  function requireConversation(cid: string): Conversation {
    const conv = conversations.find((c) => c.id === cid);
    if (!conv) throw new ApiError(404, `会话 ${cid} 不存在`, null);
    return conv;
  }

  // —— 事件发射 ——
  function nextSeq(cid: string): number {
    const s = (convSeq.get(cid) ?? 0) + 1;
    convSeq.set(cid, s);
    return s;
  }

  function emitConv(cid: string, evt: ConversationStreamEvent): void {
    const logSeq = nextSeq(cid);
    // delta / reasoning 的 data.seq 与内部 logSeq 同源分配（§7 seq 单调契约）
    const normalized: ConversationStreamEvent =
      evt.event === 'message.delta' || evt.event === 'message.reasoning'
        ? {
            event: evt.event,
            data: { ...evt.data, seq: logSeq },
          }
        : evt;
    const log = convLog.get(cid) ?? [];
    log.push({ logSeq, evt: normalized });
    if (log.length > EVENT_LOG_CAP) log.splice(0, log.length - EVENT_LOG_CAP);
    convLog.set(cid, log);
    for (const cb of convSubs.get(cid) ?? []) cb(normalized);
  }

  function emitGlobal(evt: GlobalStreamEvent): void {
    for (const cb of globalSubs) cb(evt);
  }

  function emitHardware(): void {
    emitGlobal({ event: 'hardware.updated', data: { nodes: clone(nodes) } });
  }

  function emitTask(task: Task): void {
    emitGlobal({
      event: 'task.updated',
      data: { task_id: task.id, status: task.status, steps: clone(task.steps) },
    });
  }

  // —— 硬件租约操作（维护容量不变量：操作仅经此入口）——
  function lease(nodeId: string, taskId: string, stepId: string, agentId: string): void {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.allocations.push({
      task_id: taskId,
      step_id: stepId,
      agent_id: agentId,
      leased_at: nowIso(),
    });
  }

  function releaseStep(nodeId: string, stepId: string): void {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.allocations = node.allocations.filter((a) => a.step_id !== stepId);
  }

  /** completed 后写会话历史（GET /conversations/{cid} 可回看 reasoning/artifacts）。 */
  function storeMessage(cid: string, message: Message): void {
    messagesByCid.set(cid, [...(messagesByCid.get(cid) ?? []), message]);
  }

  // —— 利用率模拟：2s 随机游走（offline 恒 0；持租约节点维持高负载）——
  const tick = setInterval(() => {
    for (const node of nodes) {
      if (node.status === 'offline') {
        node.utilization = 0;
        continue;
      }
      const base = node.allocations.length > 0 ? 0.75 : 0.15;
      const drift = (Math.random() - 0.5) * 0.12;
      node.utilization = Math.min(0.97, Math.max(0.02, base + drift));
    }
    emitHardware();
  }, TICK_MS);
  intervals.add(tick);

  // —— 脚本上下文（scripts.ts 触碰引擎状态的唯一入口）——
  const scriptCtx: MockScriptContext = {
    emitConv,
    emitGlobal,
    emitTask,
    emitHardware,
    lease,
    releaseStep,
    nextId,
    nowIso,
    tasks,
    nodes,
    storeMessage,
  };

  /** 新脚本开始前：取消所有遗留 running 任务并释放租约（保持容量不超限）。 */
  function cancelLingeringTasks(atMs: number): void {
    for (const task of tasks) {
      if (task.status !== 'running' && task.status !== 'pending') continue;
      for (const step of task.steps) {
        if (step.status !== 'running' && step.status !== 'pending') continue;
        if (step.node_id) releaseStep(step.node_id, step.id);
        step.status = 'cancelled';
        step.finished_at = nowIso();
      }
      task.status = 'cancelled';
      schedule(atMs, () => {
        emitTask(task);
        emitHardware();
      });
    }
  }

  function runScript(actions: TimedAction[], atBase: number): void {
    let t = atBase;
    for (const action of actions) {
      t += action.atMs;
      const fireAt = t;
      schedule(fireAt, action.run);
    }
  }

  // —— 管理端校验辅助 ——
  const VALID_PROVIDERS = new Set(['openai', 'anthropic', 'mock']);
  const VALID_THINKING = new Set(['off', 'low', 'high', 'max']);

  function validateChannelInput(input: ModelChannelInput): void {
    if (!input || typeof input.ref !== 'string' || input.ref.trim().length === 0) {
      throw new ApiError(422, '渠道 ref 不能为空', null);
    }
    if (!VALID_PROVIDERS.has(input.provider)) {
      throw new ApiError(422, `未知 provider：${String(input.provider)}`, null);
    }
    if (!VALID_THINKING.has(input.default_thinking)) {
      throw new ApiError(422, `非法 default_thinking：${String(input.default_thinking)}`, null);
    }
  }

  // —— ApiClient 实现 ——
  const client: MockClient = {
    async listAgents(): Promise<AgentInfo[]> {
      return clone(AGENTS);
    },
    async getTenant(): Promise<TenantInfo> {
      return clone(TENANT);
    },
    async listConversations(): Promise<Conversation[]> {
      return clone(conversations);
    },
    async createConversation(req: { agent_id?: string; title?: string }): Promise<Conversation> {
      const conv: Conversation = {
        id: nextId('c-'),
        title: req.title?.trim() || '新会话',
        // v1.1：agent_id 缺省 = orchestrator（编排入口）
        agent_id: req.agent_id ?? 'orchestrator',
        tenant_id: 'demo',
        created_at: nowIso(),
      };
      conversations.unshift(conv);
      messagesByCid.set(conv.id, []);
      return clone(conv);
    },
    async getConversation(cid: string): Promise<ConversationDetail> {
      const conv = requireConversation(cid);
      return { ...clone(conv), messages: clone(messagesByCid.get(cid) ?? []) };
    },
    async sendMessage(
      cid: string,
      content: string,
      req?: { model_ref?: string; thinking_level?: ThinkingLevel },
    ): Promise<SendMessageAck> {
      const conv = requireConversation(cid);
      const userId = nextId('m-');
      messagesByCid.set(cid, [
        ...(messagesByCid.get(cid) ?? []),
        {
          id: userId,
          conversation_id: cid,
          role: 'user',
          content,
          reasoning: '',
          agent_id: conv.agent_id,
          artifacts: [],
          created_at: nowIso(),
        },
      ]);
      // 202 语义对齐后端：预创建 assistant 消息 id 并作为 message_id 返回
      // （SSE 增量/完成事件归属它），脚本以该 id 流式输出。
      const assistantId = nextId('m-');
      // 思考程度：消息级覆盖 > 缺省 high（契约 §9 取值优先级，Mock 无渠道状态）
      const thinking = parseThinkingLevel(req?.thinking_level ?? 'high');
      // 先取消遗留 running 任务（释放容量），再启动编排脚本（atMs 已含全部时序）
      cancelLingeringTasks(80);
      const actions = buildOrchestratorScript(cid, content, assistantId, thinking, scriptCtx);
      runScript(actions, 0);
      return { message_id: assistantId, run_id: nextId('r-') };
    },
    async listTasks(conversationId?: string | null): Promise<Task[]> {
      const list = conversationId
        ? tasks.filter((tk) => tk.conversation_id === conversationId)
        : tasks;
      return clone(list);
    },
    async listHardware(): Promise<HardwareResponse> {
      return { nodes: clone(nodes) };
    },
    async listAdminModels(): Promise<ModelChannelList> {
      return { models: clone(channels) };
    },
    async putAdminModel(input: ModelChannelInput): Promise<ModelChannel> {
      validateChannelInput(input);
      const idx = channels.findIndex((c) => c.ref === input.ref);
      // api_key_inline 只写入不回显（契约 §5：响应只体现 has_api_key）
      const hadKey = idx >= 0 ? channels[idx].has_api_key : false;
      const entry: ModelChannel = {
        ref: input.ref,
        provider: input.provider,
        model: input.model,
        base_url: input.base_url,
        api_key_env: input.api_key_env,
        has_api_key: hadKey || (input.api_key_inline ?? '').length > 0,
        default_thinking: input.default_thinking,
        timeout_seconds: input.timeout_seconds,
      };
      if (idx >= 0) channels[idx] = entry;
      else channels.push(entry);
      return clone(entry);
    },
    async deleteAdminModel(ref: string): Promise<void> {
      if (BASE_CHANNEL_REFS.includes(ref)) {
        throw new ApiError(409, `渠道 ${ref} 为基底渠道（config.toml），不可删除`, null);
      }
      const idx = channels.findIndex((c) => c.ref === ref);
      if (idx < 0) throw new ApiError(404, `渠道 ${ref} 不存在`, null);
      channels.splice(idx, 1);
    },
    async listAdminPlugins(): Promise<PluginList> {
      return { plugins: clone(plugins) };
    },
    async installPlugin(req: InstallPluginRequest): Promise<PluginInfo> {
      const source = typeof req?.source_path === 'string' ? req.source_path.trim() : '';
      if (source.length === 0) {
        throw new ApiError(422, 'source_path 不能为空', null);
      }
      const name = source.replace(/\/+$/, '').split(/[\\/]/).pop() ?? source;
      if (plugins.some((p) => p.id === name)) {
        throw new ApiError(409, `插件 ${name} 已存在（重名）`, null);
      }
      const info: PluginInfo = {
        id: name,
        name,
        version: '0.1.0',
        description: `从本地目录 ${source} 安装`,
        enabled: true,
        source: 'installed',
        broken_reason: null,
      };
      plugins.push(info);
      return clone(info);
    },
    async setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) throw new ApiError(404, `插件 ${id} 不存在`, null);
      plugin.enabled = enabled === true;
      return clone(plugin);
    },
    async uninstallPlugin(id: string): Promise<void> {
      const idx = plugins.findIndex((p) => p.id === id);
      if (idx < 0) throw new ApiError(404, `插件 ${id} 不存在`, null);
      if (plugins[idx].source === 'builtin') {
        throw new ApiError(409, '内置插件不可卸载', null);
      }
      plugins.splice(idx, 1);
    },
    openConversationStream(
      cid: string,
      after: number | null,
      cb: StreamCallbacks<ConversationStreamEvent>,
    ): StreamHandle {
      const log = convLog.get(cid) ?? [];
      if (after !== null && Number.isFinite(after)) {
        // 断线重放：同步回放 logSeq > after 的条目（契约 ?after= 语义）
        for (const entry of log) {
          if (entry.logSeq > after) cb.onEvent(entry.evt);
        }
      }
      const set = convSubs.get(cid) ?? new Set();
      convSubs.set(cid, set);
      const notify = (e: ConversationStreamEvent): void => cb.onEvent(e);
      set.add(notify);
      cb.onStatus?.('online');
      return {
        close: () => {
          set.delete(notify);
        },
      };
    },
    openGlobalStream(cb: StreamCallbacks<GlobalStreamEvent>): StreamHandle {
      const notify = (e: GlobalStreamEvent): void => cb.onEvent(e);
      globalSubs.add(notify);
      cb.onStatus?.('online');
      return {
        close: () => {
          globalSubs.delete(notify);
        },
      };
    },
    dispose(): void {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const iv of intervals) clearInterval(iv);
      intervals.clear();
      convSubs.clear();
      globalSubs.clear();
    },
  };

  return client;
}
