/**
 * engine.ts —— Mock 引擎：以脚本化事件驱动完整演示链路（ARCHITECTURE §10）。
 *
 * 职责：
 *  - 实现 ApiClient 同一契约（fixtures 初始状态 + 内存可变状态）；
 *  - sendMessage 触发脚本：流式 delta → message.completed(circuit+counts) →
 *    三步 DAG 依序迁移（cpu→qpu→cpu，§10 映射）→ hardware allocation 变化，
 *    尾声在 gpu-a800-1 上留一个运行中步骤（回答"哪个 Agent 在用哪块 GPU"）；
 *  - 会话流带 seq 单调递增 + 事件日志（cap 1024）支持 ?after= 重放；
 *  - 硬件利用率模拟：2s tick 随机游走（对齐 config.toml tick_seconds=2.0）。
 * 失败行为：无网络依赖；畸形输入（未知会话）按 404 语义抛 ApiError。
 */
import { ApiError, type ApiClient } from '../client';
import type {
  AgentInfo,
  Artifact,
  Conversation,
  ConversationDetail,
  HardwareNode,
  HardwareResponse,
  Message,
  SendMessageAck,
  Step,
  Task,
  TenantInfo,
} from '../../types/domain';
import type {
  ConversationStreamEvent,
  GlobalStreamEvent,
  StreamCallbacks,
  StreamHandle,
} from '../../types/events';
import {
  AGENTS,
  CONVERSATIONS,
  HARDWARE_NODES,
  MESSAGES_BY_CID,
  TASKS,
  TENANT,
} from './fixtures';

/** 会话流日志条目：logSeq 为内部单调序号（delta 的 data.seq 与之同源）。 */
interface LoggedEvent {
  logSeq: number;
  evt: ConversationStreamEvent;
}

interface TimedAction {
  atMs: number;
  run: () => void;
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

/** 把回复文本等分为 n 段（code point 安全），用于流式 delta。 */
export function chunkText(text: string, n: number): string[] {
  const chars = Array.from(text);
  if (n <= 1 || chars.length === 0) return [chars.join('')];
  const size = Math.ceil(chars.length / n);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
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
    // delta 的 data.seq 与内部 logSeq 同源分配（§7 seq 单调契约）
    const normalized: ConversationStreamEvent =
      evt.event === 'message.delta'
        ? { event: 'message.delta', data: { ...evt.data, seq: logSeq } }
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

  // —— 脚本：按 agent 分发 ——
  function runAssistantScript(cid: string, agentId: string, atBase: number, assistantMsgId: string): void {
    const script =
      agentId === 'calibration'
        ? calibrationScript(cid, assistantMsgId)
        : agentId === 'echo'
          ? echoScript(cid, assistantMsgId)
          : vqeScript(cid, assistantMsgId);
    let t = atBase;
    for (const action of script) {
      t += action.atMs;
      const fireAt = t;
      schedule(fireAt, action.run);
    }
  }

  /** 生成 VQE 演示脚本（ARCHITECTURE §10 完整链路）。返回相对动作序列。 */
  function vqeScript(cid: string, msgId: string): TimedAction[] {
    const agentId = 'algorithm-designer';
    const text =
      '收到。正在为该问题启动 VQE 流水线：\n' +
      '1. 分子积分计算（经典 CPU）\n' +
      '2. VQE 线路执行（QPU · QuANTA 20Q）\n' +
      '3. 结果后处理（经典 CPU）\n\n' +
      'Ansatz 线路与测量计数即将输出；三步 DAG 任务已提交调度，可在右侧任务 DAG 面板观察状态迁移。';
    const chunks = chunkText(text, 10);
    const actions: TimedAction[] = chunks.map((delta, i) => ({
      atMs: i === 0 ? 300 : 90,
      run: () =>
        emitConv(cid, {
          event: 'message.delta',
          data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
        }),
    }));
    // completed 事件中的 delta seq 由 emitConv 统一分配（此处 data.seq 仅占位）

    const artCircuit: Artifact = {
      id: nextId('a-'),
      type: 'circuit',
      title: '硬件高效 Ansatz（2 qubits）',
      payload: {
        qubits: 2,
        operations: [
          { id: 'op-0', gate: 'RY', targets: [0] },
          { id: 'op-1', gate: 'RZ', targets: [1] },
          { id: 'op-2', gate: 'CNOT', controls: [0], targets: [1] },
          { id: 'op-3', gate: 'RZ', targets: [1] },
          { id: 'op-4', gate: 'CNOT', controls: [0], targets: [1] },
          { id: 'op-5', gate: 'MEASURE', targets: [0, 1] },
        ],
      },
    };
    const artCounts: Artifact = {
      id: nextId('a-'),
      type: 'counts',
      title: '测量计数（1024 shots）',
      payload: {
        shots: 1024,
        qubits: 2,
        counts: { '00': 486, '11': 508, '01': 18, '10': 12 },
      },
    };
    const fullText = text;
    actions.push({
      atMs: 300,
      run: () => {
        emitConv(cid, {
          event: 'message.completed',
          data: { conversation_id: cid, message_id: msgId, artifacts: [artCircuit, artCounts] },
        });
        messagesByCid.set(cid, [
          ...(messagesByCid.get(cid) ?? []),
          {
            id: msgId,
            conversation_id: cid,
            role: 'assistant',
            content: fullText,
            agent_id: agentId,
            artifacts: [clone(artCircuit), clone(artCounts)],
            created_at: nowIso(),
          },
        ]);
      },
    });

    // —— 三步 DAG（§10：classical→cpu-node-0，quantum→qpu，classical→cpu）——
    const taskId = nextId('t-');
    const steps: Step[] = [
      stepOf(nextId('s-'), '分子积分计算', 'classical', 'cpu-node-0', []),
      stepOf(nextId('s-'), 'VQE 线路执行', 'quantum', 'qpu-quanta-20q', []),
      stepOf(nextId('s-'), '结果后处理', 'classical', 'cpu-node-0', []),
    ];
    steps[1].depends_on = [steps[0].id];
    steps[2].depends_on = [steps[1].id];
    const task: Task = {
      id: taskId,
      conversation_id: cid,
      tenant_id: 'demo',
      name: 'VQE 全流程',
      status: 'pending',
      steps,
      created_at: nowIso(),
    };
    tasks.push(task);
    actions.push({ atMs: 300, run: () => emitTask(task) });

    const stepRun = (i: number, durationMs: number, nodeName: string | null): void => {
      actions.push({
        atMs: 300,
        run: () => {
          task.status = 'running';
          steps[i].status = 'running';
          steps[i].node_id = nodeName;
          steps[i].started_at = nowIso();
          if (nodeName) lease(nodeName, taskId, steps[i].id, agentId);
          emitTask(task);
          emitHardware();
        },
      });
      actions.push({
        atMs: durationMs,
        run: () => {
          steps[i].status = 'succeeded';
          steps[i].finished_at = nowIso();
          if (steps[i].node_id) releaseStep(steps[i].node_id, steps[i].id);
          const allDone = steps.every((s) => s.status === 'succeeded');
          if (allDone) task.status = 'succeeded';
          emitTask(task);
          emitHardware();
        },
      });
    };
    stepRun(0, 1200, 'cpu-node-0');
    stepRun(1, 1200, 'qpu-quanta-20q');
    stepRun(2, 1200, 'cpu-node-0');

    // —— 尾声：GPU 演示任务（持续运行，回答"哪个 Agent 在用哪块 GPU"）——
    const gpuTaskId = nextId('t-');
    const gpuSteps: Step[] = [
      stepOf(nextId('s-'), '读出噪声批量拟合', 'classical', 'gpu-a800-1', []),
    ];
    const gpuTask: Task = {
      id: gpuTaskId,
      conversation_id: cid,
      tenant_id: 'demo',
      name: '读出矩阵噪声表征（GPU）',
      status: 'running',
      steps: gpuSteps,
      created_at: nowIso(),
    };
    tasks.push(gpuTask);
    actions.push({
      atMs: 600,
      run: () => {
        gpuSteps[0].status = 'running';
        gpuSteps[0].started_at = nowIso();
        lease('gpu-a800-1', gpuTaskId, gpuSteps[0].id, agentId);
        emitTask(gpuTask);
        emitHardware();
      },
    });
    return actions;
  }

  function calibrationScript(cid: string, msgId: string): TimedAction[] {
    const text =
      '收到校准请求。合成 DRAG 脉冲（σ=20ns，α=-0.32）并执行 RB 序列：' +
      '波形已输出，任务将先在 GPU 上完成批量预拟合，再上 QPU 执行随机编译序列。';
    const chunks = chunkText(text, 8);
    const actions: TimedAction[] = chunks.map((delta, i) => ({
      atMs: i === 0 ? 300 : 90,
      run: () =>
        emitConv(cid, {
          event: 'message.delta',
          data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
        }),
    }));
    const artWave: Artifact = {
      id: nextId('a-'),
      type: 'waveform',
      title: 'DRAG X π 脉冲（I/Q）',
      payload: {
        sample_rate_ns: 1.0,
        unit: 'mV',
        channels: [
          {
            label: 'I',
            samples: Array.from({ length: 96 }, (_, i) =>
              Number((300 * Math.exp(-((i - 48) ** 2) / (2 * 15 ** 2))).toFixed(3)),
            ),
          },
          {
            label: 'Q',
            samples: Array.from({ length: 96 }, (_, i) =>
              Number(
                (
                  300 *
                  Math.exp(-((i - 48) ** 2) / (2 * 15 ** 2)) *
                  -0.32 *
                  ((i - 48) / 15 ** 2)
                ).toFixed(3),
              ),
            ),
          },
        ],
      },
    };
    actions.push({
      atMs: 300,
      run: () => {
        emitConv(cid, {
          event: 'message.completed',
          data: { conversation_id: cid, message_id: msgId, artifacts: [artWave] },
        });
        messagesByCid.set(cid, [
          ...(messagesByCid.get(cid) ?? []),
          {
            id: msgId,
            conversation_id: cid,
            role: 'assistant',
            content: text,
            agent_id: 'calibration',
            artifacts: [clone(artWave)],
            created_at: nowIso(),
          },
        ]);
      },
    });
    const taskId = nextId('t-');
    const steps: Step[] = [
      stepOf(nextId('s-'), '脉冲批量预拟合', 'classical', 'gpu-a800-1', []),
      stepOf(nextId('s-'), 'RB 序列执行', 'quantum', 'qpu-quanta-20q', []),
    ];
    steps[1].depends_on = [steps[0].id];
    const task: Task = { id: taskId, conversation_id: cid, tenant_id: 'demo', name: '校准任务', status: 'pending', steps, created_at: nowIso() };
    tasks.push(task);
    actions.push({ atMs: 300, run: () => emitTask(task) });
    const stepRun = (i: number, durationMs: number, nodeName: string): void => {
      actions.push({
        atMs: 300,
        run: () => {
          task.status = 'running';
          steps[i].status = 'running';
          steps[i].node_id = nodeName;
          steps[i].started_at = nowIso();
          lease(nodeName, taskId, steps[i].id, 'calibration');
          emitTask(task);
          emitHardware();
        },
      });
      actions.push({
        atMs: durationMs,
        run: () => {
          steps[i].status = 'succeeded';
          steps[i].finished_at = nowIso();
          releaseStep(nodeName, steps[i].id);
          if (steps.every((s) => s.status === 'succeeded')) task.status = 'succeeded';
          emitTask(task);
          emitHardware();
        },
      });
    };
    stepRun(0, 1000, 'gpu-a800-1');
    stepRun(1, 1000, 'qpu-quanta-20q');
    return actions;
  }

  function echoScript(cid: string, msgId: string): TimedAction[] {
    const text = '（echo）已收到你的消息。当前为 Mock 回显：无 artifact、无任务。';
    const chunks = chunkText(text, 5);
    const actions: TimedAction[] = chunks.map((delta, i) => ({
      atMs: i === 0 ? 200 : 90,
      run: () =>
        emitConv(cid, {
          event: 'message.delta',
          data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
        }),
    }));
    actions.push({
      atMs: 250,
      run: () => {
        emitConv(cid, {
          event: 'message.completed',
          data: { conversation_id: cid, message_id: msgId, artifacts: [] },
        });
        messagesByCid.set(cid, [
          ...(messagesByCid.get(cid) ?? []),
          {
            id: msgId,
            conversation_id: cid,
            role: 'assistant',
            content: text,
            agent_id: 'echo',
            artifacts: [],
            created_at: nowIso(),
          },
        ]);
      },
    });
    return actions;
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
    async createConversation(req: { agent_id: string; title?: string }): Promise<Conversation> {
      const conv: Conversation = {
        id: nextId('c-'),
        title: req.title?.trim() || '新会话',
        agent_id: req.agent_id,
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
    async sendMessage(cid: string, content: string): Promise<SendMessageAck> {
      const conv = requireConversation(cid);
      const userId = nextId('m-');
      messagesByCid.set(cid, [
        ...(messagesByCid.get(cid) ?? []),
        {
          id: userId,
          conversation_id: cid,
          role: 'user',
          content,
          agent_id: conv.agent_id,
          artifacts: [],
          created_at: nowIso(),
        },
      ]);
      // 202 语义对齐后端：预创建 assistant 消息 id 并作为 message_id 返回
      // （SSE 增量/完成事件归属它），脚本以该 id 流式输出。
      const assistantId = nextId('m-');
      // 先取消遗留 running 任务（释放容量），再启动新脚本
      cancelLingeringTasks(80);
      runAssistantScript(cid, conv.agent_id, 150, assistantId);
      return { message_id: assistantId, run_id: nextId('r-') };
    },
    async listTasks(conversationId?: string | null): Promise<Task[]> {
      const list = conversationId
        ? tasks.filter((t) => t.conversation_id === conversationId)
        : tasks;
      return clone(list);
    },
    async listHardware(): Promise<HardwareResponse> {
      return { nodes: clone(nodes) };
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

function stepOf(
  id: string,
  name: string,
  kind: Step['kind'],
  nodeId: string | null,
  dependsOn: string[],
): Step {
  return {
    id,
    name,
    kind,
    status: 'pending',
    node_id: nodeId,
    depends_on: dependsOn,
    started_at: null,
    finished_at: null,
    detail: '',
    error: null,
  };
}
