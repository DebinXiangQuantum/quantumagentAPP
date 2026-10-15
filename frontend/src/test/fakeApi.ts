/**
 * fakeApi.ts —— 可编程 ApiClient 测试替身（仅供测试注入，setApi(fake)）。
 *
 * v1.6 去 mock 化：产品内不再有 mock/演示渠道（ARCHITECTURE §3 v1.6）；
 * 原 mock 引擎承担的"驱动 store/组件行为测试"职责由本替身接管——
 *  - 预置数据：agents/tenant/会话+历史消息/硬件机群/任务/渠道/插件
 *    （src/test/data.ts，clone 后可变，测试间互不串改）；
 *  - 可脚本化流：sendMessage 可挂测试脚本（相对延时动作序列，fake timers
 *    驱动）；也可经 emitConversation/emitGlobal 手动注入任意 SSE 事件；
 *  - 会话流日志：seq 单调（delta/reasoning/agent.activity 自动补号）+
 *    ?after= 重放（接口契约 §7 语义的最小实现）；
 *  - 契约语义：REST 按 404/409/422 抛 ApiError（附件 8MB 上限、渠道
 *    provider 仅 openai|anthropic、基底渠道不可删、builtin 插件不可卸载）。
 * 失败行为：无网络依赖；dispose() 清理全部定时器与订阅（afterEach 调用）。
 */
import { ApiError, type ApiClient } from '../api/client';
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
  ModelSummary,
  PluginInfo,
  PluginList,
  SendMessageAck,
  Task,
  TenantInfo,
  ThinkingLevel,
} from '../types/domain';
import type {
  ConversationStreamEvent,
  GlobalStreamEvent,
  StreamCallbacks,
  StreamHandle,
} from '../types/events';
import {
  TEST_AGENTS,
  TEST_BASE_CHANNEL_REFS,
  TEST_CHANNELS,
  TEST_CONVERSATIONS,
  TEST_HARDWARE_NODES,
  TEST_MESSAGES_BY_CID,
  TEST_PLUGINS,
  TEST_TASKS,
  TEST_TENANT,
} from './data';

/** §5.2 v1.3：单文件上限 8MB（超限 422）。 */
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** kind 判定的文本扩展名集合（mime text/* 之外的补充，契约 §5.2）。 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.py', '.json', '.toml', '.csv', '.yaml', '.ts', '.js',
]);
const EVENT_LOG_CAP = 1024;

function nowIso(): string {
  return new Date().toISOString();
}

/** 深拷贝（structuredClone 在 Node18+/现代浏览器均可用）。 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 脚本动作：atMs 为相对上一动作的延时（与既有脚本风格一致，累计调度）。 */
export interface FakeScriptAction {
  atMs: number;
  run: (ctx: FakeScriptContext) => void;
}

/** 脚本运行上下文：事件发射 + 目标会话/消息标识。 */
export interface FakeScriptContext {
  cid: string;
  /** 后端 202 语义预创建的 assistant 消息 id（事件归属者）。 */
  assistantMessageId: string;
  content: string;
  emitConversation(evt: ConversationStreamEvent): void;
  emitGlobal(evt: GlobalStreamEvent): void;
}

export type FakeSendScript = (ctx: FakeScriptContext) => FakeScriptAction[];

export interface FakeApiClient extends ApiClient {
  /** 手动向会话订阅者推送事件（seq 缺省时自动补号，见文件头）。 */
  emitConversation(cid: string, evt: ConversationStreamEvent): void;
  /** 手动向全局订阅者推送事件（task.updated / hardware.updated / error）。 */
  emitGlobal(evt: GlobalStreamEvent): void;
  /** 设置 sendMessage 的脚本化行为（null = 仅 202 落库，不发事件）。 */
  setSendScript(script: FakeSendScript | null): void;
  /** 最近一次 sendMessage 的 (cid, content, req)——断言请求体用。 */
  readonly lastSendCall: {
    cid: string;
    content: string;
    req: Omit<import('../types/domain').SendMessageRequest, 'content'> | undefined;
  } | null;
  /** 清理全部定时器与订阅（afterEach 调用）。 */
  dispose(): void;
}

export interface FakeApiOptions {
  /** 租户角色（v1.2 管理分区可见性用例）；缺省 admin。 */
  tenantRole?: TenantInfo['role'];
}

/** 会话流日志条目：logSeq 为内部单调序号（delta/reasoning/activity 同源）。 */
interface LoggedEvent {
  logSeq: number;
  evt: ConversationStreamEvent;
}

export function createFakeApi(options: FakeApiOptions = {}): FakeApiClient {
  const conversations: Conversation[] = clone(TEST_CONVERSATIONS);
  const messagesByCid = new Map<string, Message[]>(
    Object.entries(clone(TEST_MESSAGES_BY_CID)),
  );
  const tasks: Task[] = clone(TEST_TASKS);
  const nodes: HardwareNode[] = clone(TEST_HARDWARE_NODES);
  const channels: ModelChannel[] = clone(TEST_CHANNELS);
  const plugins: PluginInfo[] = clone(TEST_PLUGINS);
  const tenant: TenantInfo = { ...clone(TEST_TENANT), role: options.tenantRole ?? TEST_TENANT.role };
  /** 附件存储：id → 元数据 + data URL（图片缩略图直接可渲染）。 */
  const attachmentsById = new Map<string, AttachmentMeta & { dataUrl: string }>();
  /** 会话 → 已上传附件 id 集合（sendMessage 校验"未知/跨会话 id → 422"）。 */
  const attachmentIdsByCid = new Map<string, Set<string>>();

  const convSeq = new Map<string, number>();
  const convLog = new Map<string, LoggedEvent[]>();
  const convSubs = new Map<string, Set<(e: ConversationStreamEvent) => void>>();
  const globalSubs = new Set<(e: GlobalStreamEvent) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let sendScript: FakeSendScript | null = null;
  let lastSendCall: FakeApiClient['lastSendCall'] = null;

  let idCounter = 100;
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

  // —— 事件发射（seq 自动补号：调用方显式给 seq 时保留，仅推进计数器）——
  function nextSeq(cid: string): number {
    const s = (convSeq.get(cid) ?? 0) + 1;
    convSeq.set(cid, s);
    return s;
  }

  function emitConversation(cid: string, evt: ConversationStreamEvent): void {
    const logSeq = nextSeq(cid);
    const hasOwnSeq =
      evt.event === 'message.delta' || evt.event === 'message.reasoning' || evt.event === 'agent.activity'
        ? typeof (evt.data as { seq?: unknown }).seq === 'number'
        : false;
    const normalized: ConversationStreamEvent = hasOwnSeq
      ? evt
      : evt.event === 'message.delta' || evt.event === 'message.reasoning' || evt.event === 'agent.activity'
        ? ({ event: evt.event, data: { ...evt.data, seq: logSeq } } as ConversationStreamEvent)
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

  // —— 管理端校验（v1.6：provider 仅真实渠道）——
  const VALID_PROVIDERS = new Set(['openai', 'anthropic']);
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

  const client: FakeApiClient = {
    async listAgents(): Promise<AgentInfo[]> {
      return clone(TEST_AGENTS);
    },
    async getTenant(): Promise<TenantInfo> {
      return clone(tenant);
    },
    async listConversations(): Promise<Conversation[]> {
      return clone(conversations);
    },
    async createConversation(req: { agent_id?: string; title?: string }): Promise<Conversation> {
      const conv: Conversation = {
        id: nextId('c-'),
        title: req.title?.trim() || '新会话',
        agent_id: req.agent_id ?? 'orchestrator',
        tenant_id: tenant.id,
        created_at: nowIso(),
      };
      conversations.unshift(clone(conv));
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
      lastSendCall = { cid, content, req };
      // §5.2 v1.3：未知/跨会话附件 id → 422
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
      messagesByCid.set(cid, [
        ...(messagesByCid.get(cid) ?? []),
        {
          id: nextId('m-'),
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
      const assistantId = nextId('m-');
      if (sendScript !== null) {
        const ctx: FakeScriptContext = {
          cid,
          assistantMessageId: assistantId,
          content,
          emitConversation: (evt) => emitConversation(cid, evt),
          emitGlobal,
        };
        let t = 0;
        for (const action of sendScript(ctx)) {
          t += action.atMs;
          const fireAt = t;
          schedule(fireAt, () => action.run(ctx));
        }
      }
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
      return att?.dataUrl ?? 'data:application/octet-stream,';
    },
    async listAdminModels(): Promise<ModelChannelList> {
      return { models: clone(channels) };
    },
    async listSelectorModels(): Promise<{ models: ModelSummary[] }> {
      const list = await this.listAdminModels();
      return {
        models: list.models.map((c) => ({
          ref: c.ref,
          provider: c.provider,
          model: c.model,
          default_thinking: c.default_thinking,
          has_api_key: c.has_api_key,
        })),
      };
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
      if (TEST_BASE_CHANNEL_REFS.includes(ref)) {
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
      if (after !== null && Number.isFinite(after)) {
        // 断线重放：同步回放 logSeq > after 的条目（契约 ?after= 语义）
        for (const entry of convLog.get(cid) ?? []) {
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
    emitConversation,
    emitGlobal,
    setSendScript(script) {
      sendScript = script;
    },
    get lastSendCall() {
      return lastSendCall;
    },
    dispose(): void {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      convSubs.clear();
      globalSubs.clear();
    },
  };

  return client;
}
