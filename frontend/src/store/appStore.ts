/**
 * appStore.ts —— 应用数据 store（zustand）：REST bootstrap + SSE 事件归并。
 *
 * 职责：
 *  - bootstrap：并行拉取 agents/tenant/conversations/hardware/tasks，
 *    打开全局流并自动选中首个会话（挂载会话流）；
 *  - 会话流归并：message.delta → streamingByCid 累积；message.completed →
 *    追加完整 assistant 消息（artifacts 一并入库）；
 *  - 全局流归并：task.updated → upsert（未知 task 以事件包络合成占位）；
 *    hardware.updated → 节点替换 + 利用率历史滚动（60s 窗口，cap 30 样本）；
 *  - 连接灯：会话流/全局流状态聚合（任一 offline → offline，否则 connecting/online）。
 * 失败行为：bootstrap 失败 → bootError + 可重试；流 error 事件 → streamError
 *   （消息区展示，不中断订阅）。
 */
import { create } from 'zustand';
import { getApi } from '../api';
import type {
  AgentInfo,
  Conversation,
  HardwareNode,
  Message,
  Task,
  TenantInfo,
} from '../types/domain';
import type {
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
  tasks: Task[];
  hardwareNodes: HardwareNode[];
  utilHistoryByNode: Record<string, number[]>;
  connection: StreamStatus;
  currentAgentId: string | null;
  streamError: string | null;

  bootstrap: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
  selectConversation: (cid: string) => Promise<void>;
  createConversation: (agentId: string, title?: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  setCurrentAgent: (agentId: string) => void;
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

  function handleConversationEvent(cid: string, evt: ConversationStreamEvent): void {
    if (evt.event === 'message.delta') {
      const { message_id: mid, delta, seq } = evt.data;
      if (Number.isFinite(seq)) lastSeqByCid.set(cid, Math.max(lastSeqByCid.get(cid) ?? 0, seq));
      set((s) => {
        const prev = s.streamingByCid[cid];
        return {
          streamingByCid: {
            ...s.streamingByCid,
            [cid]:
              prev && prev.messageId === mid
                ? { messageId: mid, text: prev.text + delta }
                : { messageId: mid, text: delta },
          },
        };
      });
      return;
    }
    if (evt.event === 'message.completed') {
      const { message_id: mid, artifacts } = evt.data;
      set((s) => {
        const streamed = s.streamingByCid[cid];
        const conv = s.conversations.find((c) => c.id === cid);
        const full: Message = {
          id: mid,
          conversation_id: cid,
          role: 'assistant',
          content: streamed?.messageId === mid ? streamed.text : '',
          agent_id: conv?.agent_id ?? '',
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
        const idx = s.tasks.findIndex((t) => t.id === taskId);
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
          name: `任务 ${taskId}`,
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

  async function bootstrapInner(): Promise<void> {
    const api = getApi();
    const [agents, tenant, conversations, hardware, tasks] = await Promise.all([
      api.listAgents(),
      api.getTenant(),
      api.listConversations(),
      api.listHardware(),
      api.listTasks(),
    ]);
    set({
      agents,
      tenant,
      conversations,
      hardwareNodes: hardware.nodes,
      tasks,
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
    tasks: [],
    hardwareNodes: [],
    utilHistoryByNode: {},
    connection: 'connecting',
    currentAgentId: null,
    streamError: null,

    bootstrap: async () => {
      if (get().booted) return;
      try {
        await bootstrapInner();
      } catch (err) {
        set({
          bootError:
            err instanceof Error ? err.message : '初始化失败（未知错误）',
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
            err instanceof Error ? err.message : '初始化失败（未知错误）',
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
              err instanceof Error ? `消息加载失败：${err.message}` : '消息加载失败',
          });
        }
      }
    },

    createConversation: async (agentId, title) => {
      const conv = await getApi().createConversation({ agent_id: agentId, title });
      set((s) => ({ conversations: [conv, ...s.conversations] }));
      await get().selectConversation(conv.id);
    },

    sendMessage: async (content) => {
      const cid = get().activeConversationId;
      const trimmed = content.trim();
      if (!cid || trimmed.length === 0) return;
      const conv = get().conversations.find((c) => c.id === cid);
      await getApi().sendMessage(cid, trimmed);
      // 202 语义（契约 §5 修订）：ack.message_id 是后端**预创建的 assistant
      // 消息** id（SSE 增量归属者），绝不能用作本地用户消息 id——否则
      // message.completed 的按 id 去重会把 assistant 消息连同 artifacts 吞掉。
      // 用户消息用本地临时 id 上屏；刷新后以后端落库的真实消息为准。
      const localUserId = `local-user-${nextLocalSeq()}`;
      set((s) => {
        const list = s.messagesByCid[cid] ?? [];
        if (list.some((m) => m.id === localUserId)) return s;
        const userMsg: Message = {
          id: localUserId,
          conversation_id: cid,
          role: 'user',
          content: trimmed,
          agent_id: conv?.agent_id ?? '',
          artifacts: [],
          created_at: new Date().toISOString(),
        };
        return { messagesByCid: { ...s.messagesByCid, [cid]: [...list, userMsg] } };
      });
    },

    setCurrentAgent: (agentId) => set({ currentAgentId: agentId }),

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
        tasks: [],
        hardwareNodes: [],
        utilHistoryByNode: {},
        connection: 'connecting',
        currentAgentId: null,
        streamError: null,
      });
    },
  };
});
