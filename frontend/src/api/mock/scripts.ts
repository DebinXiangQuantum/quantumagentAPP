/**
 * scripts.ts —— Mock 引擎的脚本化动作序列（ARCHITECTURE §10 + v1.1 编排/思考）。
 *
 * 职责：
 *  - buildOrchestratorScript：v1.1 编排入口——先流式输出思考增量
 *    （message.reasoning，thinking=off 时跳过），再按用户文本启发式
 *    dispatch_agent 到专家（algorithm-designer / calibration / echo），
 *    专家脚本产出正文 delta、completed（circuit+counts / waveform / 无）与
 *    DAG/hardware 推进；
 *  - 三个专家脚本：VQE 全链路（三步 DAG，§10 验收基线）、校准（waveform +
 *    GPU/QPU 两步）、回显（最小链路）。
 * 契约：动作只经 MockScriptContext 触碰引擎状态（事件发射/租约/任务表），
 *  纯函数式拼装，计时全部相对（atMs），由引擎统一调度。
 * 失败行为：无 IO；畸形文本按空串处理。
 */
import type {
  Artifact,
  HardwareNode,
  Message,
  Step,
  Task,
  ThinkingLevel,
} from '../../types/domain';
import type { ConversationStreamEvent, GlobalStreamEvent } from '../../types/events';

export interface TimedAction {
  atMs: number;
  run: () => void;
}

/** 脚本触碰引擎状态的唯一入口（事件发射 / 硬件租约 / 任务表 / 消息表）。 */
export interface MockScriptContext {
  emitConv(cid: string, evt: ConversationStreamEvent): void;
  emitGlobal(evt: GlobalStreamEvent): void;
  emitTask(task: Task): void;
  emitHardware(): void;
  lease(nodeId: string, taskId: string, stepId: string, agentId: string): void;
  releaseStep(nodeId: string, stepId: string): void;
  nextId(prefix: string): string;
  nowIso(): string;
  tasks: Task[];
  nodes: HardwareNode[];
  /** completed 后把完整 assistant 消息写入会话历史（GET 可见） */
  storeMessage(cid: string, message: Message): void;
}

/** 专家 id（orchestrator 可 dispatch 的目标；嵌套深度 = 1）。 */
export type ExpertId = 'algorithm-designer' | 'calibration' | 'echo';

/** 编排启发式：按用户文本判断 dispatch 目标（Mock 版"模型自主决策"）。 */
export function pickExpertId(userText: string): ExpertId {
  const text = typeof userText === 'string' ? userText : '';
  if (/回显|冒烟|echo/i.test(text)) return 'echo';
  if (/校准|脉冲|波形|rb|calibrat|pulse|waveform/i.test(text)) return 'calibration';
  return 'algorithm-designer';
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

/** 编排思考文本（v1.1：reasoning 全文，先于正文流式输出）。 */
function buildReasoningText(userText: string, expert: ExpertId): string {
  const firstLine = (userText.split('\n')[0] ?? '').slice(0, 40);
  const expertLabel: Record<ExpertId, string> = {
    'algorithm-designer': '量子算法设计（问题建模/线路合成/VQE 全流程）',
    calibration: '量子校准（脉冲合成/RB 表征，产出波形）',
    echo: '回显测试（最小链路，无产物）',
  };
  return (
    `用户请求：「${firstLine}」。\n` +
    `可用专家：量子算法设计、量子校准、回显测试。该任务匹配 ${expertLabel[expert]}，` +
    `调用 dispatch_agent("${expert}") 转发上下文并等待其回复与 artifacts。`
  );
}

// —— 编排脚本时序（相对 ms；保证 600ms 内出现首个正文 delta，联调基线）——
const REASONING_START = 150;
const REASONING_STEP = 110;
const CONTENT_START = 490;

/** 绝对时刻 → 相邻增量（引擎按"上一动作后等待 atMs"调度；同时刻保序）。 */
function absoluteToDelta(actions: TimedAction[]): TimedAction[] {
  const sorted = [...actions].sort((a, b) => a.atMs - b.atMs);
  let prev = 0;
  return sorted.map((action) => {
    const delta = action.atMs - prev;
    prev = action.atMs;
    return { atMs: delta, run: action.run };
  });
}

/**
 * v1.1 编排脚本：思考增量（可跳过）→ 专家脚本（正文/产物/任务）。
 * thinking='off' 时不发 reasoning（对齐 ThinkingLevel 语义）。
 */
export function buildOrchestratorScript(
  cid: string,
  userText: string,
  msgId: string,
  thinking: ThinkingLevel,
  ctx: MockScriptContext,
): TimedAction[] {
  const expert = pickExpertId(userText);
  const actions: TimedAction[] = [];
  let reasoning = '';
  if (thinking !== 'off') {
    reasoning = buildReasoningText(userText, expert);
    const chunks = chunkText(reasoning, 3);
    chunks.forEach((delta, i) => {
      actions.push({
        atMs: REASONING_START + i * REASONING_STEP,
        run: () =>
          ctx.emitConv(cid, {
            event: 'message.reasoning',
            data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
          }),
      });
    });
  }
  const expertActions =
    expert === 'calibration'
      ? calibrationScript(cid, msgId, reasoning, ctx)
      : expert === 'echo'
        ? echoScript(cid, msgId, reasoning, ctx)
        : vqeScript(cid, msgId, reasoning, ctx);
  // 专家脚本动作为绝对时刻（首条正文 300/200ms），整体重定位到 CONTENT_START
  const firstAt = expertActions.length > 0 ? expertActions[0].atMs : 300;
  const base = thinking === 'off' ? 250 : CONTENT_START;
  for (const action of expertActions) {
    actions.push({ atMs: base + (action.atMs - firstAt), run: action.run });
  }
  return absoluteToDelta(actions);
}

/** 生成 VQE 演示脚本（ARCHITECTURE §10 完整链路）。返回相对动作序列。 */
export function vqeScript(
  cid: string,
  msgId: string,
  reasoning: string,
  ctx: MockScriptContext,
): TimedAction[] {
  const agentId = 'algorithm-designer';
  const text =
    '收到。正在为该问题启动 VQE 流水线：\n' +
    '1. 分子积分计算（经典 CPU）\n' +
    '2. VQE 线路执行（QPU · QuANTA 20Q）\n' +
    '3. 结果后处理（经典 CPU）\n\n' +
    'Ansatz 线路与测量计数即将输出；三步 DAG 任务已提交调度，可在右侧任务 DAG 面板观察状态迁移。';
  const chunks = chunkText(text, 10);
  const actions: TimedAction[] = [];
  let at = 0; // 绝对时刻（首条正文 300ms；编排脚本会整体重定位）
  for (const [i, delta] of chunks.entries()) {
    at += i === 0 ? 300 : 90;
    actions.push({
      atMs: at,
      run: () =>
        ctx.emitConv(cid, {
          event: 'message.delta',
          data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
        }),
    });
  }

  const artCircuit: Artifact = {
    id: ctx.nextId('a-'),
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
    id: ctx.nextId('a-'),
    type: 'counts',
    title: '测量计数（1024 shots）',
    payload: {
      shots: 1024,
      qubits: 2,
      counts: { '00': 486, '11': 508, '01': 18, '10': 12 },
    },
  };
  at += 300;
  actions.push({
    atMs: at,
    run: () => {
      ctx.emitConv(cid, {
        event: 'message.completed',
        data: {
          conversation_id: cid,
          message_id: msgId,
          artifacts: [artCircuit, artCounts],
          reasoning,
        },
      });
      ctx.storeMessage(cid, {
        id: msgId,
        conversation_id: cid,
        role: 'assistant',
        content: text,
        reasoning,
        agent_id: agentId,
        artifacts: [artCircuit, artCounts],
        created_at: ctx.nowIso(),
      });
    },
  });

  // —— 三步 DAG（§10：classical→cpu-node-0，quantum→qpu，classical→cpu）——
  const taskId = ctx.nextId('t-');
  const steps: Step[] = [
    stepOf(ctx.nextId('s-'), '分子积分计算', 'classical', 'cpu-node-0', []),
    stepOf(ctx.nextId('s-'), 'VQE 线路执行', 'quantum', 'qpu-quanta-20q', []),
    stepOf(ctx.nextId('s-'), '结果后处理', 'classical', 'cpu-node-0', []),
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
    created_at: ctx.nowIso(),
  };
  ctx.tasks.push(task);
  at += 300;
  actions.push({ atMs: at, run: () => ctx.emitTask(task) });

  const stepRun = (i: number, durationMs: number, nodeName: string | null): void => {
    at += 300;
    actions.push({
      atMs: at,
      run: () => {
        task.status = 'running';
        steps[i].status = 'running';
        steps[i].node_id = nodeName;
        steps[i].started_at = ctx.nowIso();
        if (nodeName) ctx.lease(nodeName, taskId, steps[i].id, agentId);
        ctx.emitTask(task);
        ctx.emitHardware();
      },
    });
    at += durationMs;
    actions.push({
      atMs: at,
      run: () => {
        steps[i].status = 'succeeded';
        steps[i].finished_at = ctx.nowIso();
        if (steps[i].node_id) ctx.releaseStep(steps[i].node_id, steps[i].id);
        const allDone = steps.every((s) => s.status === 'succeeded');
        if (allDone) task.status = 'succeeded';
        ctx.emitTask(task);
        ctx.emitHardware();
      },
    });
  };
  stepRun(0, 1200, 'cpu-node-0');
  stepRun(1, 1200, 'qpu-quanta-20q');
  stepRun(2, 1200, 'cpu-node-0');

  // —— 尾声：GPU 演示任务（持续运行，回答"哪个 Agent 在用哪块 GPU"）——
  const gpuTaskId = ctx.nextId('t-');
  const gpuSteps: Step[] = [
    stepOf(ctx.nextId('s-'), '读出噪声批量拟合', 'classical', 'gpu-a800-1', []),
  ];
  const gpuTask: Task = {
    id: gpuTaskId,
    conversation_id: cid,
    tenant_id: 'demo',
    name: '读出矩阵噪声表征（GPU）',
    status: 'running',
    steps: gpuSteps,
    created_at: ctx.nowIso(),
  };
  ctx.tasks.push(gpuTask);
  at += 600;
  actions.push({
    atMs: at,
    run: () => {
      gpuSteps[0].status = 'running';
      gpuSteps[0].started_at = ctx.nowIso();
      ctx.lease('gpu-a800-1', gpuTaskId, gpuSteps[0].id, agentId);
      ctx.emitTask(gpuTask);
      ctx.emitHardware();
    },
  });
  return actions;
}

export function calibrationScript(
  cid: string,
  msgId: string,
  reasoning: string,
  ctx: MockScriptContext,
): TimedAction[] {
  const agentId = 'calibration';
  const text =
    '收到校准请求。合成 DRAG 脉冲（σ=20ns，α=-0.32）并执行 RB 序列：' +
    '波形已输出，任务将先在 GPU 上完成批量预拟合，再上 QPU 执行随机编译序列。';
  const chunks = chunkText(text, 8);
  const actions: TimedAction[] = [];
  let at = 0; // 绝对时刻（首条正文 300ms；编排脚本会整体重定位）
  for (const [i, delta] of chunks.entries()) {
    at += i === 0 ? 300 : 90;
    actions.push({
      atMs: at,
      run: () =>
        ctx.emitConv(cid, {
          event: 'message.delta',
          data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
        }),
    });
  }
  const artWave: Artifact = {
    id: ctx.nextId('a-'),
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
  at += 300;
  actions.push({
    atMs: at,
    run: () => {
      ctx.emitConv(cid, {
        event: 'message.completed',
        data: {
          conversation_id: cid,
          message_id: msgId,
          artifacts: [artWave],
          reasoning,
        },
      });
      ctx.storeMessage(cid, {
        id: msgId,
        conversation_id: cid,
        role: 'assistant',
        content: text,
        reasoning,
        agent_id: agentId,
        artifacts: [artWave],
        created_at: ctx.nowIso(),
      });
    },
  });
  const taskId = ctx.nextId('t-');
  const steps: Step[] = [
    stepOf(ctx.nextId('s-'), '脉冲批量预拟合', 'classical', 'gpu-a800-1', []),
    stepOf(ctx.nextId('s-'), 'RB 序列执行', 'quantum', 'qpu-quanta-20q', []),
  ];
  steps[1].depends_on = [steps[0].id];
  const task: Task = { id: taskId, conversation_id: cid, tenant_id: 'demo', name: '校准任务', status: 'pending', steps, created_at: ctx.nowIso() };
  ctx.tasks.push(task);
  at += 300;
  actions.push({ atMs: at, run: () => ctx.emitTask(task) });
  const stepRun = (i: number, durationMs: number, nodeName: string): void => {
    at += 300;
    actions.push({
      atMs: at,
      run: () => {
        task.status = 'running';
        steps[i].status = 'running';
        steps[i].node_id = nodeName;
        steps[i].started_at = ctx.nowIso();
        ctx.lease(nodeName, taskId, steps[i].id, agentId);
        ctx.emitTask(task);
        ctx.emitHardware();
      },
    });
    at += durationMs;
    actions.push({
      atMs: at,
      run: () => {
        steps[i].status = 'succeeded';
        steps[i].finished_at = ctx.nowIso();
        ctx.releaseStep(nodeName, steps[i].id);
        if (steps.every((s) => s.status === 'succeeded')) task.status = 'succeeded';
        ctx.emitTask(task);
        ctx.emitHardware();
      },
    });
  };
  stepRun(0, 1000, 'gpu-a800-1');
  stepRun(1, 1000, 'qpu-quanta-20q');
  return actions;
}

export function echoScript(
  cid: string,
  msgId: string,
  reasoning: string,
  ctx: MockScriptContext,
): TimedAction[] {
  const text = '（echo）已收到你的消息。当前为 Mock 回显：无 artifact、无任务。';
  const chunks = chunkText(text, 5);
  const actions: TimedAction[] = [];
  let at = 0; // 绝对时刻（首条正文 200ms；编排脚本会整体重定位）
  for (const [i, delta] of chunks.entries()) {
    at += i === 0 ? 200 : 90;
    actions.push({
      atMs: at,
      run: () =>
        ctx.emitConv(cid, {
          event: 'message.delta',
          data: { conversation_id: cid, message_id: msgId, delta, seq: 0 },
        }),
    });
  }
  at += 250;
  actions.push({
    atMs: at,
    run: () => {
      ctx.emitConv(cid, {
        event: 'message.completed',
        data: { conversation_id: cid, message_id: msgId, artifacts: [], reasoning },
      });
      ctx.storeMessage(cid, {
        id: msgId,
        conversation_id: cid,
        role: 'assistant',
        content: text,
        reasoning,
        agent_id: 'echo',
        artifacts: [],
        created_at: ctx.nowIso(),
      });
    },
  });
  return actions;
}
