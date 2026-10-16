/**
 * appStore.ts —— 应用数据 store（zustand）：REST bootstrap + SSE 事件归并。
 *
 * 职责：
 *  - bootstrap：并行拉取 agents/tenant/conversations/hardware/tasks/渠道池，
 *    打开全局流并自动选中首个会话（挂载会话流）；渠道池决定初始
 *    模型/思考程度（本地偏好 > 渠道列表首项；思考跟随渠道 default_thinking）；
 *  - 会话流归并：message.reasoning（v1.1 思考增量，先于正文）与 message.delta
 *    分别累积于 streamingByCid；message.completed → 追加完整 assistant 消息
 *    （artifacts + reasoning 全文入库）；
 *  - v1.4 归并：agent.activity 按 message_id→agentId 聚合进
 *    subagentActivityByMessage（专家工作区渐进块数据源；seq 单调门控，
 *    乱序/重复丢弃）；artifact.created 即时插卡（未 completed → 流式消息
 *    临时 artifacts 骨架态；completed 事件携带 artifacts 全量覆盖去重）；
 *  - 全局流归并：task.updated → upsert（未知 task 以事件包络合成占位）；
 *    hardware.updated → 节点替换 + 利用率历史滚动（60s 窗口，cap 30 样本）；
 *  - 顶栏选择（v1.1）：selectModel 切换渠道（思考程度跟随新渠道
 *    default_thinking，除非本会话已手动改过）；selectThinking 手动覆盖
 *    （thinkingTouched 置位，本会话内跨模型切换保持）；
 *  - v1.2 自动建会话（§5）：sendMessage 无活跃会话 → createConversation
 *    （标题=消息前 20 字）→ 发送；404 → 自动新建重试一次；期间 sending
 *    置位（按钮发送中态），非 404 失败 → sendError + failedDraft 内联重试。
 *  - 连接灯：会话流/全局流状态聚合（任一 offline → offline，否则 connecting/online）。
 * 失败行为：bootstrap 失败 → bootError + 可重试（渠道池拉取失败不阻断启动，
 *   仅置空模型选择）；流 error 事件 → streamError（消息区展示，不中断订阅）。
 */
import { create } from 'zustand';
import { getApi } from '../api';
import { ApiError } from '../api/client';
import { t } from '../i18n';
import { useUiStore } from './uiStore';
import type {
  AgentInfo,
  Artifact,
  AttachmentMeta,
  Conversation,
  HardwareNode,
  Message,
  ModelSummary,
  SendMessageAck,
  Task,
  TenantInfo,
  ThinkingLevel,
} from '../types/domain';
import { parseThinkingLevel } from '../types/domain';
import type {
  AgentActivityPhase,
  ConversationStreamEvent,
  GlobalStreamEvent,
  StreamHandle,
  StreamStatus,
} from '../types/events';

/** 利用率滚动窗口：2s tick × 30 = 60s（design.md §6.4）。 */
export const UTIL_HISTORY_CAP = 30;

/** 乐观上屏用户消息的本地序号（真实 id 由后端落库，刷新后替换）。 */
let localMessageSeq = 0;
function nextLocalSeq(): number {
  localMessageSeq += 1;
  return localMessageSeq;
}

interface StreamingMessage {
  messageId: string;
  text: string;
  /** v1.1：思考过程累积缓冲（message.reasoning 增量；与 text 同一缓冲模式） */
  reasoning?: string;
  /** v1.4：artifact.created 即时插卡缓冲（completed 时被事件全量覆盖）。 */
  artifacts?: Artifact[];
}

/**
 * v1.4 单个专家（dispatch_agent 子 Agent）在一条消息内的聚合活动：
 * message_id → agentId 聚合；reasoning/text 增量追加进 text，tool_call
 * 依序记录工具名；dispatch_completed 收束 phase（保留全文供回看）。
 */
export interface SubagentActivity {
  agentId: string;
  phase: AgentActivityPhase;
  /** reasoning/text 增量累计全文（专家工作区正文） */
  text: string;
  /** 已调用工具名（按调用顺序；畸形 tool 降级为占位空串） */
  tools: string[];
}

/** 发送失败的草稿（内联重试用；附件元数据一并保留以便重试渲染）。 */
export interface FailedDraft {
  content: string;
  attachmentIds: string[];
  attachments: AttachmentMeta[];
}

export interface AppDataState {
  booted: boolean;
  bootError: string | null;
  agents: AgentInfo[];
  tenant: TenantInfo | null;
  conversations: Conversation[];
  activeConversationId: string | null;
  /** 已加载过消息的会话（避免重复拉取） */
  loadedCids: Record<string, boolean>;
  messagesByCid: Record<string, Message[]>;
  streamingByCid: Record<string, StreamingMessage | undefined>;
  /**
   * v1.4 专家工作区聚合：message_id → 各 agentId 的 SubagentActivity。
   * 运行中由 MessageBubble 渐进块实时外显；完成后折叠摘要（内存态，
   * 刷新后不回放——活动为流式期 affordance）。
   */
  subagentActivityByMessage: Record<string, SubagentActivity[]>;
  tasks: Task[];
  hardwareNodes: HardwareNode[];
  utilHistoryByNode: Record<string, number[]>;
  connection: StreamStatus;
  streamError: string | null;

  /** v1.2 发送中态 + 失败内联重试（design.md §5） */
  sending: boolean;
  sendError: string | null;
  failedDraft: FailedDraft | null;

  /** v1.1 渠道池 + 顶栏选择（§5） */
  modelChannels: ModelSummary[];
  currentModelRef: string | null;
  currentThinkingLevel: ThinkingLevel | null;
  /** 本会话是否手动改过思考程度（改过则切模型不再跟随渠道默认） */
  thinkingTouched: boolean;

  bootstrap: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
  selectConversation: (cid: string) => Promise<void>;
  createConversation: (title?: string) => Promise<Conversation>;
  /**
   * 确保存在活跃会话并返回 cid（无则自动新建，标题=seed 前 20 字）——
   * composer 附件上传前调用（§5.2：附件必须挂在会话下）。
   */
  ensureConversation: (titleSeed: string) => Promise<string>;
  /**
   * v1.2/v1.3 发送：无活跃会话自动建会话（标题=消息前 20 字）；404 自动
   * 重建重试一次；失败 → sendError + failedDraft（retrySend 重发）。
   */
  sendMessage: (
    content: string,
    opts?: { attachmentIds?: string[]; attachments?: AttachmentMeta[] },
  ) => Promise<void>;
  /** 重发失败草稿（无草稿时静默返回）。 */
  retrySend: () => Promise<void>;
  clearSendError: () => void;
  /** 刷新渠道池（设置页保存/删除后调用；保持当前选择若仍存在） */
  refreshModelChannels: () => Promise<void>;
  selectModel: (ref: string) => void;
  selectThinking: (level: ThinkingLevel) => void;
  clearStreamError: () => void;
  /** 仅供测试：复位全部状态并关闭流。 */
  resetForTest: () => void;
}

// —— 流句柄与状态（模块级：非渲染数据，不入 store）——
let convHandle: StreamHandle | null = null;
let globalHandle: StreamHandle | null = null;
let convStatus: StreamStatus = 'connecting';
let globalStatus: StreamStatus = 'connecting';
const lastSeqByCid = new Map<string, number>();

function combineStatus(): StreamStatus {
  if (convStatus === 'offline' || globalStatus === 'offline') return 'offline';
  if (convStatus === 'connecting' || globalStatus === 'connecting') return 'connecting';
  return 'online';
}

export const useAppStore = create<AppDataState>((set, get) => {
  function recomputeConnection(): void {
    set({ connection: combineStatus() });
  }
  /**
   * §7 seq 单调门控：携带 seq 的事件（delta/reasoning/agent.activity）
   * 若 seq ≤ 已见最大值（乱序/重复，如断线重放）则丢弃，不污染增量拼接。
   * 返回 false = 丢弃。无 seq 字段或畸形 seq 的事件不门控（降级放行）。
   */
  function seqGate(cid: string, seq: unknown): boolean {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return true;
    const last = lastSeqByCid.get(cid) ?? 0;
    if (seq <= last) return false;
    lastSeqByCid.set(cid, seq);
    return true;
  }

  /** v1.4 agent.activity 归并：按 message_id → agentId 聚合（见 SubagentActivity）。 */
  function mergeAgentActivity(cid: string, data: import('../types/events').AgentActivityData): void {
    if (!seqGate(cid, data.seq)) return;
    const { message_id: mid, agent_id: agentId, phase, delta, tool } = data;
    set((s) => {
      const list = s.subagentActivityByMessage[mid] ?? [];
      const idx = list.findIndex((a) => a.agentId === agentId);
      const prev: SubagentActivity =
        idx >= 0 ? list[idx] : { agentId, phase: 'dispatch_started', text: '', tools: [] };
      let next: SubagentActivity;
      if (phase === 'reasoning_delta' || phase === 'text_delta') {
        next = {
          ...prev,
          phase,
          text: prev.text + (typeof delta === 'string' ? delta : ''),
        };
      } else if (phase === 'tool_call') {
        next = {
          ...prev,
          phase,
          tools: [...prev.tools, typeof tool === 'string' ? tool : ''],
        };
      } else {
        // dispatch_started / dispatch_completed：只迁移 phase（text/tools 保留）
        next = { ...prev, phase };
      }
      return {
        subagentActivityByMessage: {
          ...s.subagentActivityByMessage,
          [mid]: idx >= 0 ? list.map((a, i) => (i === idx ? next : a)) : [...list, next],
        },
      };
    });
  }

  /**
   * v1.4 artifact.created 即时插卡：消息未 completed → 追加进流式消息
   * 临时 artifacts；已完成 → 就地追加进该消息 artifacts。均按 artifact.id
   * 去重；畸形 artifact（非对象）忽略。
   */
  function insertStreamArtifact(
    cid: string,
    data: import('../types/events').ArtifactCreatedData,
  ): void {
    const artifact = data?.artifact;
    if (artifact === null || typeof artifact !== 'object') return;
    const mid = data.message_id;
    set((s) => {
      const list = s.messagesByCid[cid] ?? [];
      const targetIdx = list.findIndex((m) => m.id === mid);
      if (targetIdx >= 0) {
        const target = list[targetIdx];
        const artifacts = Array.isArray(target.artifacts) ? target.artifacts : [];
        if (artifacts.some((a) => a?.id === artifact.id)) return s;
        const nextList = [...list];
        nextList[targetIdx] = { ...target, artifacts: [...artifacts, artifact] };
        return { messagesByCid: { ...s.messagesByCid, [cid]: nextList } };
      }
      const prev = s.streamingByCid[cid];
      if (!prev || prev.messageId !== mid) return s;
      const temp = Array.isArray(prev.artifacts) ? prev.artifacts : [];
      if (temp.some((a) => a?.id === artifact.id)) return s;
      return {
        streamingByCid: {
          ...s.streamingByCid,
          [cid]: { ...prev, artifacts: [...temp, artifact] },
        },
      };
    });
  }

  function handleConversationEvent(cid: string, evt: ConversationStreamEvent): void {
    if (evt.event === 'message.delta' || evt.event === 'message.reasoning') {
      const { message_id: mid, delta, seq } = evt.data;
      if (!seqGate(cid, seq)) return;
      const field = evt.event === 'message.delta' ? 'text' : 'reasoning';
      set((s) => {
        const prev = s.streamingByCid[cid];
        const base =
          prev && prev.messageId === mid
            ? prev
            : { messageId: mid, text: '', reasoning: '' };
        return {
          streamingByCid: {
            ...s.streamingByCid,
            [cid]: { ...base, [field]: (field === 'text' ? base.text : base.reasoning ?? '') + delta },
          },
        };
      });
      return;
    }
    if (evt.event === 'agent.activity') {
      mergeAgentActivity(cid, evt.data);
      return;
    }
    if (evt.event === 'artifact.created') {
      insertStreamArtifact(cid, evt.data);
      return;
    }
    if (evt.event === 'message.completed') {
      const { message_id: mid, artifacts, reasoning } = evt.data;
      set((s) => {
        const streamed = s.streamingByCid[cid];
        const conv = s.conversations.find((c) => c.id === cid);
        const full: Message = {
          id: mid,
          conversation_id: cid,
          role: 'assistant',
          content: streamed?.messageId === mid ? streamed.text : '',
          // completed 的 reasoning 为思考全文（契约 §7）；缺省回退流式缓冲
          reasoning:
            typeof reasoning === 'string'
              ? reasoning
              : streamed?.messageId === mid
                ? streamed.reasoning ?? ''
                : '',
          agent_id: conv?.agent_id ?? 'orchestrator',
          artifacts,
          created_at: new Date().toISOString(),
        };
        const list = s.messagesByCid[cid] ?? [];
        const nextStreaming = { ...s.streamingByCid };
        delete nextStreaming[cid];
        return {
          messagesByCid: {
            ...s.messagesByCid,
            [cid]: list.some((m) => m.id === mid) ? list : [...list, full],
          },
          streamingByCid: nextStreaming,
        };
      });
      return;
    }
    // error 事件：展示但不中断订阅（SSE 仍保持）
    set({ streamError: `${evt.data.code}: ${evt.data.message}` });
  }

  function handleGlobalEvent(evt: GlobalStreamEvent): void {
    if (evt.event === 'task.updated') {
      const { task_id: taskId, status, steps } = evt.data;
      set((s) => {
        const idx = s.tasks.findIndex((tk) => tk.id === taskId);
        if (idx >= 0) {
          const tasks = [...s.tasks];
          tasks[idx] = { ...tasks[idx], status, steps };
          return { tasks };
        }
        // 未知任务：以事件包络合成占位（名称/会话关联待后续 listTasks 补全）
        const synthetic: Task = {
          id: taskId,
          conversation_id: s.activeConversationId ?? '',
          tenant_id: '',
          name: t('task.syntheticName', { id: taskId }),
          status,
          steps,
          created_at: new Date().toISOString(),
        };
        return { tasks: [...s.tasks, synthetic] };
      });
      return;
    }
    if (evt.event === 'hardware.updated') {
      const nodes = Array.isArray(evt.data.nodes) ? evt.data.nodes : [];
      set((s) => {
        const history: Record<string, number[]> = { ...s.utilHistoryByNode };
        for (const node of nodes) {
          const capped = Number.isFinite(node.utilization)
            ? Math.min(1, Math.max(0, node.utilization))
            : 0;
          const arr = [...(history[node.id] ?? []), capped];
          if (arr.length > UTIL_HISTORY_CAP) arr.splice(0, arr.length - UTIL_HISTORY_CAP);
          history[node.id] = arr;
        }
        return { hardwareNodes: nodes, utilHistoryByNode: history };
      });
      return;
    }
    set({ streamError: `${evt.data.code}: ${evt.data.message}` });
  }

  function openConversationStream(cid: string): void {
    convHandle?.close();
    convStatus = 'connecting';
    convHandle = getApi().openConversationStream(cid, lastSeqByCid.get(cid) ?? null, {
      onEvent: (evt) => handleConversationEvent(cid, evt),
      onStatus: (st) => {
        convStatus = st;
        recomputeConnection();
      },
    });
    recomputeConnection();
  }

  /** §5 v1.2 自动建会话标题：消息前 20 字（code point 安全截断）。 */
  function autoTitle(seed: string): string {
    const chars = Array.from(seed);
    return chars.slice(0, 20).join('');
  }

  /**
   * 确保存在活跃会话并返回其 id：无（或 force=true 重建）时自动新建，
   * 标题取 seed 前 20 字（design.md §5 v1.2）。
   */
  async function ensureConversationInner(seed: string, force = false): Promise<string> {
    if (!force) {
      const cid = get().activeConversationId;
      if (cid !== null) return cid;
    }
    const conv = await getApi().createConversation({
      title: autoTitle(seed.length > 0 ? seed : t('chat.autoTitle')),
    });
    set((s) => ({ conversations: [conv, ...s.conversations] }));
    await get().selectConversation(conv.id);
    return conv.id;
  }

  /** §5/v1.1 POST body：可选模型/思考覆盖 + v1.3 attachment_ids（空数组不携带）。 */
  async function postMessageInner(
    cid: string,
    content: string,
    attachmentIds: string[],
  ): Promise<SendMessageAck> {
    const s = get();
    return getApi().sendMessage(cid, content, {
      ...(s.currentModelRef ? { model_ref: s.currentModelRef } : {}),
      ...(s.currentThinkingLevel ? { thinking_level: s.currentThinkingLevel } : {}),
      ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
    });
  }

  async function bootstrapInner(): Promise<void> {    const api = getApi();
    const [agents, tenant, conversations, hardware, tasks, channelList] =
      await Promise.all([
        api.listAgents(),
        api.getTenant(),
        api.listConversations(),
        api.listHardware(),
        api.listTasks(),
        // 渠道池失败不阻断启动（管理 API 可能未部署）
        // v1.3：选择器走任意角色可读的 /models（普通用户 admin 端点 403）
        api.listSelectorModels().catch(() => ({ models: [] })),
      ]);
    const channels = Array.isArray(channelList?.models) ? channelList.models : [];
    // 初始选择：本地偏好（若仍存在）> 渠道列表首项；思考跟随渠道 default_thinking
    const prefs = useUiStore.getState();
    const preferred =
      prefs.defaultModelRef !== null
        ? channels.find((c) => c.ref === prefs.defaultModelRef)
        : undefined;
    const initialChannel = preferred ?? channels[0] ?? null;
    const initialThinking =
      prefs.defaultThinking ??
      (initialChannel ? parseThinkingLevel(initialChannel.default_thinking) : null);
    set({
      agents,
      tenant,
      conversations,
      hardwareNodes: hardware.nodes,
      tasks,
      modelChannels: channels,
      currentModelRef: initialChannel?.ref ?? null,
      currentThinkingLevel: initialThinking,
      thinkingTouched: prefs.defaultThinking !== null,
      bootError: null,
    });
    // 全局流（task/hardware 事件）
    globalHandle?.close();
    globalStatus = 'connecting';
    globalHandle = api.openGlobalStream({
      onEvent: handleGlobalEvent,
      onStatus: (st) => {
        globalStatus = st;
        recomputeConnection();
      },
    });
    // 自动选中首个会话并挂载消息
    if (conversations.length > 0 && get().activeConversationId === null) {
      await get().selectConversation(conversations[0].id);
    }
    set({ booted: true });
  }

  return {
    booted: false,
    bootError: null,
    agents: [],
    tenant: null,
    conversations: [],
    activeConversationId: null,
    loadedCids: {},
    messagesByCid: {},
    streamingByCid: {},
    subagentActivityByMessage: {},
    tasks: [],
    hardwareNodes: [],
    utilHistoryByNode: {},
    connection: 'connecting',
    streamError: null,
    sending: false,
    sendError: null,
    failedDraft: null,
    modelChannels: [],
    currentModelRef: null,
    currentThinkingLevel: null,
    thinkingTouched: false,

    bootstrap: async () => {
      if (get().booted) return;
      try {
        await bootstrapInner();
      } catch (err) {
        set({
          bootError:
            err instanceof Error ? err.message : t('error.boot'),
        });
      }
    },

    retryBootstrap: async () => {
      set({ bootError: null, booted: false });
      try {
        await bootstrapInner();
      } catch (err) {
        set({
          bootError:
            err instanceof Error ? err.message : t('error.boot'),
        });
      }
    },

    selectConversation: async (cid) => {
      set({ activeConversationId: cid, streamError: null });
      openConversationStream(cid);
      if (!get().loadedCids[cid]) {
        try {
          const detail = await getApi().getConversation(cid);
          set((s) => ({
            messagesByCid: { ...s.messagesByCid, [cid]: detail.messages },
            loadedCids: { ...s.loadedCids, [cid]: true },
          }));
        } catch (err) {
          set({
            streamError:
              err instanceof Error
                ? t('error.messagesLoadDetail', { message: err.message })
                : t('error.messagesLoad'),
          });
        }
      }
    },

    createConversation: async (title) => {
      // v1.1：agent_id 缺省 = orchestrator 编排入口（契约 §4）
      const conv = await getApi().createConversation({ title });
      set((s) => ({ conversations: [conv, ...s.conversations] }));
      await get().selectConversation(conv.id);
      return conv;
    },

    ensureConversation: async (titleSeed) => ensureConversationInner(titleSeed),

    sendMessage: async (content, opts) => {
      const trimmed = content.trim();
      const attachmentIds = Array.isArray(opts?.attachmentIds)
        ? opts!.attachmentIds
        : [];
      const attachments = Array.isArray(opts?.attachments) ? opts!.attachments : [];
      // 纯空白且无附件不发送；发送中防重入（按钮同时置禁用）
      if ((trimmed.length === 0 && attachmentIds.length === 0) || get().sending) {
        return;
      }
      set({ sending: true, sendError: null, failedDraft: null });
      try {
        let cid = await ensureConversationInner(trimmed);
        let ack: SendMessageAck;
        try {
          ack = await postMessageInner(cid, trimmed, attachmentIds);
        } catch (err) {
          // §5 v1.2：会话 404（如后端重启内存态清空）→ 自动新建重试一次
          if (err instanceof ApiError && err.status === 404) {
            cid = await ensureConversationInner(trimmed, true);
            ack = await postMessageInner(cid, trimmed, attachmentIds);
          } else {
            throw err;
          }
        }
        // 202 语义（契约 §5 修订）：ack.message_id 是后端**预创建的 assistant
        // 消息** id（SSE 增量归属者），绝不能用作本地用户消息 id——否则
        // message.completed 的按 id 去重会把 assistant 消息连同 artifacts 吞掉。
        // 用户消息用本地临时 id 上屏；刷新后以后端落库的真实消息为准。
        void ack;
        const localUserId = `local-user-${nextLocalSeq()}`;
        // 会话标题自动生成（用户走查反馈）：自动建会话的标题可能因 seed
        // 为空而缺失——首条真实消息发出后，把侧栏标题同步为消息摘要
        set((s2) => ({
          conversations: s2.conversations.map((c) =>
            c.id === cid && (c.title.length === 0 || c.title === t('chat.autoTitle'))
              ? { ...c, title: autoTitle(trimmed) }
              : c,
          ),
        }));
        set((s2) => {
          const list = s2.messagesByCid[cid] ?? [];
          if (list.some((m) => m.id === localUserId)) return s2;
          const userMsg: Message = {
            id: localUserId,
            conversation_id: cid,
            role: 'user',
            content: trimmed,
            agent_id: 'orchestrator',
            artifacts: [],
            ...(attachments.length > 0 ? { attachments } : {}),
            created_at: new Date().toISOString(),
          };
          return {
            messagesByCid: { ...s2.messagesByCid, [cid]: [...list, userMsg] },
          };
        });
      } catch (err) {
        // 失败内联重试：保留草稿（含附件），composer 展示重试按钮
        set({
          sendError:
            err instanceof ApiError
              ? `${err.status}: ${err.message}`
              : err instanceof Error
                ? err.message
                : t('error.send'),
          failedDraft: { content: trimmed, attachmentIds, attachments },
        });
      } finally {
        set({ sending: false });
      }
    },

    retrySend: async () => {
      const draft = get().failedDraft;
      if (draft === null) return;
      set({ failedDraft: null });
      await get().sendMessage(draft.content, {
        attachmentIds: draft.attachmentIds,
        attachments: draft.attachments,
      });
    },

    clearSendError: () => set({ sendError: null, failedDraft: null }),

    refreshModelChannels: async () => {
      const list = await getApi().listSelectorModels();
      const channels = Array.isArray(list?.models) ? list.models : [];
      set((s) => {
        const stillThere =
          s.currentModelRef !== null &&
          channels.some((c) => c.ref === s.currentModelRef);
        const nextRef = stillThere ? s.currentModelRef : channels[0]?.ref ?? null;
        const nextChannel = channels.find((c) => c.ref === nextRef) ?? null;
        return {
          modelChannels: channels,
          currentModelRef: nextRef,
          // 当前选择被删除 → 回到首渠道默认思考；否则保持
          currentThinkingLevel: stillThere
            ? s.currentThinkingLevel
            : nextChannel
              ? parseThinkingLevel(nextChannel.default_thinking)
              : null,
          thinkingTouched: stillThere ? s.thinkingTouched : false,
        };
      });
    },

    selectModel: (ref) => {
      set((s) => {
        const channel = s.modelChannels.find((c) => c.ref === ref);
        if (!channel) return s; // 未知渠道忽略
        // 思考程度：本会话未手动改过 → 跟随新渠道 default_thinking
        const thinking = s.thinkingTouched
          ? s.currentThinkingLevel
          : parseThinkingLevel(channel.default_thinking);
        // 粘性修复（用户走查反馈）：手动选模型同时持久化到 uiStore
        // localStorage——刷新/bootstrap 不再重置回渠道列表首项
        useUiStore.getState().setDefaultModelRef(ref);
        return { currentModelRef: ref, currentThinkingLevel: thinking };
      });
    },

    selectThinking: (level) => {
      set({ currentThinkingLevel: level, thinkingTouched: true });
    },

    clearStreamError: () => set({ streamError: null }),

    resetForTest: () => {
      convHandle?.close();
      convHandle = null;
      globalHandle?.close();
      globalHandle = null;
      convStatus = 'connecting';
      globalStatus = 'connecting';
      lastSeqByCid.clear();
      set({
        booted: false,
        bootError: null,
        agents: [],
        tenant: null,
        conversations: [],
        activeConversationId: null,
        loadedCids: {},
        messagesByCid: {},
        streamingByCid: {},
        subagentActivityByMessage: {},
        tasks: [],
        hardwareNodes: [],
        utilHistoryByNode: {},
        connection: 'connecting',
        streamError: null,
        sending: false,
        sendError: null,
        failedDraft: null,
        modelChannels: [],
        currentModelRef: null,
        currentThinkingLevel: null,
        thinkingTouched: false,
      });
    },
  };
});
