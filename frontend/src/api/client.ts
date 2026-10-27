/**
 * client.ts —— REST + SSE 客户端（严格对齐 docs/ARCHITECTURE.md §5/§7）。
 *
 * 职责：
 *  - RestClient：fetch 封装（Bearer 鉴权、JSON 解析、ApiError 携带状态码与
 *    Retry-After）；
 *  - 会话流 / 全局流：EventSource 封装，断线后**自行接管重连**
 *    （指数退避 nextBackoffMs，上限 30s；会话流带 ?after=<lastSeq> 续传）；
 *  - ApiClient 接口：测试以 src/test/fakeApi.ts 测试替身实现（setApi 注入；
 *    v1.6 起 product 恒为真实后端，无 mock 引擎）。
 *
 * 失败行为：非 2xx → 抛 ApiError；流断开 → onStatus('offline'|'connecting') +
 * 自动重连，恢复后 onStatus('online')；JSON 畸形 → 流事件被丢弃并按 error 上抛。
 */
import type {
  AgentInfo,
  AttachmentMeta,
  Conversation,
  ConversationDetail,
  HardwareResponse,
  InstallPluginRequest,
  ModelChannel,
  ModelChannelInput,
  ModelChannelList,
  ModelSummary,
  PluginInfo,
  PluginList,
  SendMessageAck,
  SendMessageRequest,
  Task,
  TenantInfo,
} from '../types/domain';
import type {
  ConversationStreamEvent,
  GlobalStreamEvent,
  StreamCallbacks,
  StreamHandle,
  StreamStatus,
} from '../types/events';

/** 后端业务错误（401/403/404/422/429…）。 */
export class ApiError extends Error {
  readonly status: number;
  /** 429 时来自 Retry-After 头（秒）；其余为 null */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 指数退避：第 attempt 次失败后等待 1000 * 2^attempt ms，封顶 30000ms。
 * attempt < 0 或 NaN 按 0 处理（防御式，不抛异常）。
 */
export function nextBackoffMs(attempt: number): number {
  const a =
    Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(1000 * 2 ** a, 30_000);
}

/**
 * 会话流 URL：/api/v1/conversations/{cid}/stream[?after=<seq>&api_key=<key>]。
 * api_key：EventSource 无法携带 Authorization 头（浏览器 API 限制，MDN），
 * SSE 鉴权必须经查询参数兜底（后端契约 §5 修订，头存在时以头为准）。
 */
export function buildStreamUrl(
  base: string,
  cid: string,
  after: number | null,
  apiKey?: string,
): string {
  const params = new URLSearchParams();
  if (after !== null && Number.isFinite(after)) {
    params.set('after', String(Math.max(0, Math.floor(after))));
  }
  if (apiKey) params.set('api_key', apiKey);
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';
  return `${base.replace(/\/+$/, '')}/api/v1/conversations/${encodeURIComponent(cid)}/stream${suffix}`;
}

/** 全局流 URL：/api/v1/events[?api_key=<key>]（鉴权同上，无 after 续传）。 */
export function buildGlobalStreamUrl(base: string, apiKey?: string): string {
  const suffix = apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : '';
  return `${base.replace(/\/+$/, '')}/api/v1/events${suffix}`;
}

/** 平台统一 API 面（真实后端与 Mock 实现同一契约）。 */
export interface ApiClient {
  listAgents(): Promise<AgentInfo[]>;
  getTenant(): Promise<TenantInfo>;
  listConversations(limit?: number): Promise<Conversation[]>;
  createConversation(req: { agent_id?: string; title?: string }): Promise<Conversation>;
  getConversation(cid: string): Promise<ConversationDetail>;
  /** v1.1：可选 model_ref/thinking_level 覆盖（ARCHITECTURE §5）；v1.3 增 attachment_ids。 */
  sendMessage(cid: string, content: string, req?: Omit<SendMessageRequest, 'content'>): Promise<SendMessageAck>;
  /** §5.2 v1.3：上传附件（multipart file，单文件 ≤ 8MB，超限 422）。 */
  uploadAttachment(cid: string, file: File): Promise<AttachmentMeta>;
  /** §5.2 v1.3：附件原始字节 URL（<img> 缩略图用；Mock 为 data: URL）。 */
  attachmentRawUrl(id: string): string;
  listTasks(conversationId?: string | null): Promise<Task[]>;
  /** §4 v1.3：取单个任务（嵌套 DAG 下钻用；不存在 → 404）。 */
  getTask(tid: string): Promise<Task>;
  listHardware(): Promise<HardwareResponse>;
  /** v1.1 管理平台：渠道池（§5）。 */
  listAdminModels(): Promise<ModelChannelList>;
  /** v1.3：任意角色可读的模型选择器列表（输入区下拉数据源）。 */
  listSelectorModels(): Promise<{ models: ModelSummary[] }>;
  putAdminModel(input: ModelChannelInput): Promise<ModelChannel>;
  /** 删除本地覆盖渠道；基底渠道不可删 → ApiError(409)。 */
  deleteAdminModel(ref: string): Promise<void>;
  /** v1.1 插件管理（§8）：列表含 builtin/installed/broken。 */
  listAdminPlugins(): Promise<PluginList>;
  installPlugin(req: InstallPluginRequest): Promise<PluginInfo>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo>;
  /** builtin 插件不可卸载 → ApiError(409)。 */
  uninstallPlugin(id: string): Promise<void>;
  /** 订阅会话 SSE；after 为已知最大 seq（断线续传），首次传 null。 */
  openConversationStream(
    cid: string,
    after: number | null,
    cb: StreamCallbacks<ConversationStreamEvent>,
  ): StreamHandle;
  /** 订阅全局 SSE（task.updated / hardware.updated / error）。 */
  openGlobalStream(cb: StreamCallbacks<GlobalStreamEvent>): StreamHandle;
}

/**
 * 后端地址：默认**同源**（''，dev 由 Vite 代理 /api → 127.0.0.1:8000；
 * v1.3 修订——部分内嵌 webview 跨域 fetch 会静默挂起）。VITE_API_BASE
 * 可覆盖为绝对地址（独立部署后端时使用）。
 */
const DEFAULT_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const DEFAULT_KEY = 'demo-key';

/** localStorage 键（允许演示时覆盖 Bearer，不写死在代码里）。 */
const API_KEY_STORAGE = 'qap.apiKey';

export class RestClient implements ApiClient {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(base: string = DEFAULT_BASE, apiKey?: string) {
    this.base = base.replace(/\/+$/, '');
    this.apiKey =
      apiKey ??
      (typeof localStorage !== 'undefined'
        ? localStorage.getItem(API_KEY_STORAGE) ?? DEFAULT_KEY
        : DEFAULT_KEY);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    // multipart（附件上传）由浏览器补 boundary，禁止手工 JSON Content-Type
    const isMultipart =
      typeof FormData !== 'undefined' && init?.body instanceof FormData;
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(init?.body && !isMultipart ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      // 后端错误体为 {"error":{code,message}}（ARCHITECTURE §5）——优先取
      // 业务消息；非 JSON 体（网关/代理错误）退回通用文案。
      let message = `API ${path} 失败：HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error?.message) {
          const code = body.error.code ? `（${body.error.code}）` : '';
          message = `${body.error.message}${code}`;
        }
      } catch {
        /* 保留通用文案 */
      }
      const retryAfter = res.headers.get('Retry-After');
      throw new ApiError(
        res.status,
        message,
        retryAfter !== null ? Number(retryAfter) : null,
      );
    }
    // 204/空体安全处理
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listAgents(): Promise<AgentInfo[]> {
    return this.request<AgentInfo[]>('/api/v1/agents');
  }

  getTenant(): Promise<TenantInfo> {
    return this.request<TenantInfo>('/api/v1/tenants/me');
  }

  listConversations(limit?: number): Promise<Conversation[]> {
    const q = limit && limit > 0 ? `?limit=${Math.floor(limit)}` : '';
    return this.request<Conversation[]>(`/api/v1/conversations${q}`);
  }

  createConversation(req: { agent_id?: string; title?: string }): Promise<Conversation> {
    return this.request<Conversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  getConversation(cid: string): Promise<ConversationDetail> {
    return this.request<ConversationDetail>(
      `/api/v1/conversations/${encodeURIComponent(cid)}`,
    );
  }

  sendMessage(
    cid: string,
    content: string,
    req?: Omit<SendMessageRequest, 'content'>,
  ): Promise<SendMessageAck> {
    return this.request<SendMessageAck>(
      `/api/v1/conversations/${encodeURIComponent(cid)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content, ...(req ?? {}) }),
      },
    );
  }

  uploadAttachment(cid: string, file: File): Promise<AttachmentMeta> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.request<AttachmentMeta>(
      `/api/v1/conversations/${encodeURIComponent(cid)}/attachments`,
      { method: 'POST', body: form },
    );
  }

  /**
   * 附件 raw URL：<img> 无法携带 Authorization 头，沿用 SSE 的 ?api_key=
   * 查询参数兜底（原型权衡，见 ARCHITECTURE §5/§13——生产应换一次性 ticket）。
   */
  attachmentRawUrl(id: string): string {
    return `${this.base}/api/v1/attachments/${encodeURIComponent(id)}/raw?api_key=${encodeURIComponent(this.apiKey)}`;
  }

  listTasks(conversationId?: string | null): Promise<Task[]> {
    const q = conversationId
      ? `?conversation_id=${encodeURIComponent(conversationId)}`
      : '';
    return this.request<Task[]>(`/api/v1/tasks${q}`);
  }

  getTask(tid: string): Promise<Task> {
    return this.request<Task>(`/api/v1/tasks/${encodeURIComponent(tid)}`);
  }

  listHardware(): Promise<HardwareResponse> {
    return this.request<HardwareResponse>('/api/v1/hardware');
  }

  listAdminModels(): Promise<ModelChannelList> {
    return this.request<ModelChannelList>('/api/v1/admin/models');
  }

  listSelectorModels(): Promise<{ models: ModelSummary[] }> {
    return this.request<{ models: ModelSummary[] }>('/api/v1/models');
  }

  putAdminModel(input: ModelChannelInput): Promise<ModelChannel> {
    return this.request<ModelChannel>(
      `/api/v1/admin/models/${encodeURIComponent(input.ref)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }

  deleteAdminModel(ref: string): Promise<void> {
    return this.request<void>(
      `/api/v1/admin/models/${encodeURIComponent(ref)}`,
      { method: 'DELETE' },
    );
  }

  listAdminPlugins(): Promise<PluginList> {
    return this.request<PluginList>('/api/v1/admin/plugins');
  }

  installPlugin(req: InstallPluginRequest): Promise<PluginInfo> {
    return this.request<PluginInfo>('/api/v1/admin/plugins/install', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    return this.request<PluginInfo>(
      `/api/v1/admin/plugins/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    );
  }

  uninstallPlugin(id: string): Promise<void> {
    return this.request<void>(
      `/api/v1/admin/plugins/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  openConversationStream(
    cid: string,
    after: number | null,
    cb: StreamCallbacks<ConversationStreamEvent>,
  ): StreamHandle {
    return new ConversationStream(this.base, cid, after, cb, this.apiKey);
  }

  openGlobalStream(cb: StreamCallbacks<GlobalStreamEvent>): StreamHandle {
    return new ReconnectingStream(
      () => buildGlobalStreamUrl(this.base, this.apiKey),
      ['task.updated', 'hardware.updated', 'error'],
      cb as StreamCallbacks<never>,
    );
  }
}

/**
 * 可重连 EventSource 封装。
 * 目的：原生 EventSource 会自动以实现相关策略重连，但契约要求 ?after= 续传 +
 * 指数退避（上限 30s），故在 error 时 close() 后自行接管。
 * 假设：浏览器 EventSource 存在（Mock 模式不走此路径；单测覆盖纯逻辑部分）。
 * 失败行为：error → onStatus('offline') → 退避后 onStatus('connecting') →
 * 重开；成功 open → onStatus('online') 且退避计数清零。
 */
class ReconnectingStream {
  private es: EventSource | null = null;
  private attempt = 0;
  private lastSeq: number | null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly buildUrlFn: (seq: number | null) => string,
    private readonly eventNames: string[],
    private readonly cb: StreamCallbacks<never>,
    initialSeq: number | null = null,
  ) {
    this.lastSeq = initialSeq;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.cb.onStatus?.('connecting');
    const es = new EventSource(this.buildUrlFn(this.lastSeq));
    this.es = es;
    es.onopen = () => {
      this.attempt = 0;
      this.cb.onStatus?.('online');
    };
    es.onerror = () => {
      // 立即挂断，改由我们的退避策略重连（避免实现相关行为）
      es.close();
      this.es = null;
      if (this.closed) return;
      this.cb.onStatus?.('offline');
      this.timer = setTimeout(() => {
        this.attempt += 1;
        this.connect();
      }, nextBackoffMs(this.attempt));
    };
    for (const name of this.eventNames) {
      es.addEventListener(name, (ev: MessageEvent) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as never;
          // 会话流按 seq 单调续传（§7）：delta 与 reasoning 增量都携带 seq
          if (name === 'message.delta' || name === 'message.reasoning') {
            const seq = (data as unknown as { seq?: number }).seq;
            if (typeof seq === 'number' && Number.isFinite(seq)) {
              this.lastSeq = Math.max(this.lastSeq ?? 0, seq);
            }
          }
          this.cb.onEvent({ event: name, data } as never);
        } catch {
          // 畸形 JSON：按 error 语义上抛，不让监听器崩溃
          this.cb.onEvent({
            event: 'error',
            data: { code: 'stream.parse', message: 'SSE data 非合法 JSON' },
          } as never);
        }
      });
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.es?.close();
    this.es = null;
  }
}

/** 会话流：URL 携带 ?after=<lastSeq> 续传与 ?api_key= 鉴权（EventSource 限制）。 */
class ConversationStream extends ReconnectingStream {
  constructor(
    base: string,
    cid: string,
    after: number | null,
    cb: StreamCallbacks<ConversationStreamEvent>,
    apiKey: string,
  ) {
    super(
      (seq) => buildStreamUrl(base, cid, seq, apiKey),
      ['message.delta', 'message.reasoning', 'message.completed',
       'agent.activity', 'artifact.created', 'task.updated', 'error'],
      cb as StreamCallbacks<never>,
      after,
    );
  }
}

export type { StreamStatus };
