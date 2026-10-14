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
  AttachmentMeta,
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
/** §5.2 v1.3：单文件上限 8MB（超限 422）。 */
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** kind 判定的文本扩展名集合（mime text/* 之外的补充，契约 §5.2）。 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.py', '.json', '.toml', '.csv', '.yaml', '.ts', '.js',
]);

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
  /** §5.2 v1.3 附件存储：id → 元数据 + data URL（图片缩略图直接可渲染）。 */
  const attachmentsById = new Map<string, AttachmentMeta & { dataUrl: string }>();
  /** 会话 → 已上传附件 id 集合（sendMessage 校验"未知/跨会话 id → 422"）。 */
  const attachmentIdsByCid = new Map<string, Set<string>>();

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
      // v1.2 metrics 缓慢漂移：QPU 保真度每 tick ≤0.0002（契约 §4）、
      // CPU/GPU 使用率与显存随机走（始终满足 used ≤ total / usage ∈ [0,1]）
      const m = node.metrics;
      if (m !== undefined && m !== null && typeof m === 'object') {
        if ('topology' in m) {
          // v1.4：云端真机无保真度（字段可选）——只漂移已存在的样本值
          const driftFid = (v: number): number =>
            Math.min(1, Math.max(0.9, v + (Math.random() - 0.5) * 0.0002));
          for (const q of m.topology.qubits) {
            if (typeof q.readout_fidelity === 'number') {
              q.readout_fidelity = Number(driftFid(q.readout_fidelity).toFixed(4));
            }
            if (typeof q.sq_fidelity === 'number') {
              q.sq_fidelity = Number(driftFid(q.sq_fidelity).toFixed(4));
            }
          }
          for (const c of m.topology.couplers) {
            if (typeof c.tq_fidelity === 'number') {
              c.tq_fidelity = Number(driftFid(c.tq_fidelity).toFixed(4));
            }
          }
        } else if ('cpu_usage' in m) {
          m.cpu_usage = Math.min(1, Math.max(0.02, m.cpu_usage + (Math.random() - 0.5) * 0.08));
          m.memory_used_gb = Math.min(
            m.memory_total_gb,
            Math.max(1, m.memory_used_gb + (Math.random() - 0.5) * 2),
          );
        } else if ('vram_total_gb' in m) {
          m.vram_used_gb = Math.min(
            m.vram_total_gb,
            Math.max(0.5, m.vram_used_gb + (Math.random() - 0.5) * 1.5),
          );
        }
      }
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
      // v1.2 双角色演示：localStorage['qap.mockRole'] = 'user' 后刷新即普通
      // 用户视角（管理分区隐藏）；缺省 admin（fixtures TENANT.role）
      let role: TenantInfo['role'] = TENANT.role;
      try {
        const override = typeof localStorage !== 'undefined' ? localStorage.getItem('qap.mockRole') : null;
        if (override === 'user' || override === 'admin') role = override;
      } catch {
        /* 隐私模式等：仅默认 */
      }
      return { ...clone(TENANT), role };
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
      req?: {
        model_ref?: string;
        thinking_level?: ThinkingLevel;
        attachment_ids?: string[];
      },
    ): Promise<SendMessageAck> {
      const conv = requireConversation(cid);
      // §5.2 v1.3：未知/跨会话附件 id → 422（契约语义）
      const attachmentIds = Array.isArray(req?.attachment_ids) ? req!.attachment_ids! : [];
      const owned = attachmentIdsByCid.get(cid) ?? new Set<string>();
      const known = attachmentIds.filter((id) => owned.has(id));
      if (known.length !== attachmentIds.length) {
        throw new ApiError(422, '存在未知或不属于该会话的附件 id', null);
      }
      const attMeta: AttachmentMeta[] = [];
      for (const id of known) {
        const stored = attachmentsById.get(id);
        if (stored !== undefined) {
          const { dataUrl: _drop, ...meta } = stored;
          attMeta.push(meta);
        }
      }
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
          ...(attMeta.length > 0 ? { attachments: attMeta } : {}),
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
    async getTask(tid: string): Promise<Task> {
      const task = tasks.find((tk) => tk.id === tid);
      if (!task) throw new ApiError(404, `任务 ${tid} 不存在`, null);
      return clone(task);
    },
    async listHardware(): Promise<HardwareResponse> {
      return { nodes: clone(nodes) };
    },
    async uploadAttachment(cid: string, file: File): Promise<AttachmentMeta> {
      requireConversation(cid);
      if (!(file instanceof File)) {
        throw new ApiError(422, '请求体缺少 multipart file 字段', null);
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        throw new ApiError(422, `单文件不得超过 8MB（当前 ${file.size} 字节）`, null);
      }
      if (file.size === 0 && file.name !== '') {
        throw new ApiError(422, '空文件不可上传', null);
      }
      const mime = file.type || 'application/octet-stream';
      const lower = file.name.toLowerCase();
      const ext = lower.slice(lower.lastIndexOf('.'));
      const kind: AttachmentMeta['kind'] =
        mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)
            ? 'text'
            : 'file';
      const id = nextId('att-');
      // 图片构建 data: URL（缩略图可直接渲染）；非图片/超大文件降级空体
      let dataUrl = `data:${mime};base64,`;
      if (kind === 'image' && file.size <= 1_048_576) {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          for (const byte of buf) bin += String.fromCharCode(byte);
          dataUrl = `data:${mime};base64,${btoa(bin)}`;
        } catch {
          /* 环境限制时保留空 data URL */
        }
      }
      const meta: AttachmentMeta & { dataUrl: string } = {
        id,
        name: file.name,
        mime,
        size: file.size,
        kind,
        dataUrl,
      };
      attachmentsById.set(id, meta);
      const owned = attachmentIdsByCid.get(cid) ?? new Set<string>();
      owned.add(id);
      attachmentIdsByCid.set(cid, owned);
      const { dataUrl: _drop, ...rest } = meta;
      return { ...rest };
    },
    attachmentRawUrl(id: string): string {
      const att = attachmentsById.get(id);
      return att?.dataUrl ?? `data:application/octet-stream,`;
    },
    async listSelectorModels(): Promise<{ models: import('../../types/domain').ModelSummary[] }> {
      // v1.3：任意角色可读的选择器列表（从渠道 fixtures 投影，去掉管理细节）
      const channels = await this.listAdminModels();
      return {
        models: channels.models.map((c) => ({
          ref: c.ref,
          provider: c.provider,
          model: c.model,
          default_thinking: c.default_thinking,
          has_api_key: c.has_api_key,
        })),
      };
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
