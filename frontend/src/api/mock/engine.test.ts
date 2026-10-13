/**
 * engine.test.ts —— Mock 引擎脚本化演示链路的可观察行为测试
 * （对齐 docs/ARCHITECTURE.md §10 验收基线）。
 *
 * 覆盖：
 *  1. SSE 事件顺序：message.delta… → message.completed（含 circuit+counts）；
 *  2. seq 严格单调递增（断线续传 ?after= 的前提）；
 *  3. counts 不变量：sum(counts.values()) == shots（§4 不变量 2）；
 *  4. 三步 DAG 依序推进：classical(cpu) → quantum(qpu) → classical(cpu)，
 *     依赖链式，task.updated 全量推送；
 *  5. hardware.updated：quantum 步 running 期间 qpu 节点出现 allocation，
 *     任务完成后释放；「哪个 Agent 在用哪块 GPU」可回答（演示尾步占 GPU）；
 *  6. 断线重连：close 后累积的事件在以 after 重开时完整重放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from './engine';
import type {
  ConversationStreamEvent,
  GlobalStreamEvent,
} from '../../types/events';
import type {
  CircuitPayload,
  CountsPayload,
  HardwareNode,
  Step,
} from '../../types/domain';

interface Harness {
  convEvents: ConversationStreamEvent[];
  globalEvents: GlobalStreamEvent[];
  closeConv: () => void;
  closeGlobal: () => void;
}

describe('Mock 引擎脚本化运行', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 订阅两条流并发送一条消息，随后快进全部定时器。 */
  function runScript(client: ReturnType<typeof createMockClient>, text: string): Harness {
    const convEvents: ConversationStreamEvent[] = [];
    const globalEvents: GlobalStreamEvent[] = [];
    const conv = client.openConversationStream('c-1', null, {
      onEvent: (e) => convEvents.push(e),
    });
    const global = client.openGlobalStream({
      onEvent: (e) => globalEvents.push(e),
    });
    void client.sendMessage('c-1', text);
    // 脚本总时长约 9s，快进 20s 覆盖全部阶段
    vi.advanceTimersByTime(20_000);
    return { convEvents, globalEvents, closeConv: conv.close, closeGlobal: global.close };
  }

  it('事件顺序：先全部 delta，后 completed；completed 含 circuit+counts', () => {
    const client = createMockClient();
    const { convEvents } = runScript(client, '请设计 VQE 线路');
    const kinds = convEvents.map((e) => e.event);
    const firstCompleted = kinds.indexOf('message.completed');
    expect(firstCompleted).toBeGreaterThan(0);
    // completed 之前全部是 delta，之后没有 delta
    for (let i = 0; i < firstCompleted; i += 1) expect(kinds[i]).toBe('message.delta');
    for (let i = firstCompleted; i < kinds.length; i += 1) {
      expect(kinds[i]).toBe('message.completed');
    }
    const completed = convEvents[firstCompleted];
    expect(completed.event).toBe('message.completed');
    if (completed.event !== 'message.completed') throw new Error('unreachable');
    const types = completed.data.artifacts.map((a) => a.type).sort();
    expect(types).toEqual(['circuit', 'counts']);
  });

  it('seq 严格单调递增（SSE mock 流）', () => {
    const client = createMockClient();
    const { convEvents } = runScript(client, '请设计 VQE 线路');
    const seqs = convEvents
      .filter((e) => e.event === 'message.delta')
      .map((e) => (e.event === 'message.delta' ? e.data.seq : 0));
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('counts 不变量：sum(counts)==shots；比特串长度==qubits', () => {
    const client = createMockClient();
    const { convEvents } = runScript(client, '请设计 VQE 线路');
    const completed = convEvents.find((e) => e.event === 'message.completed');
    expect(completed).toBeDefined();
    if (!completed || completed.event !== 'message.completed') throw new Error('x');
    const countsArtifact = completed.data.artifacts.find((a) => a.type === 'counts');
    expect(countsArtifact).toBeDefined();
    const payload = countsArtifact!.payload as CountsPayload;
    const sum = Object.values(payload.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(payload.shots);
    for (const key of Object.keys(payload.counts)) {
      expect(key.length).toBe(payload.qubits);
    }
  });

  it('circuit 载荷合法：qubits ∈ [1,32]，targets 落在界内', () => {
    const client = createMockClient();
    const { convEvents } = runScript(client, '请设计 VQE 线路');
    const completed = convEvents.find(
      (e) => e.event === 'message.completed',
    ) as Extract<ConversationStreamEvent, { event: 'message.completed' }> | undefined;
    expect(completed).toBeDefined();
    const circuitArtifact = completed!.data.artifacts.find((a) => a.type === 'circuit');
    const payload = circuitArtifact!.payload as CircuitPayload;
    expect(payload.qubits).toBeGreaterThanOrEqual(1);
    expect(payload.qubits).toBeLessThanOrEqual(32);
    for (const op of payload.operations) {
      for (const t of [...op.targets, ...(op.controls ?? [])]) {
        expect(t).toBeLessThan(payload.qubits);
        expect(t).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('三步 DAG：依赖链式 classical→quantum→classical；task.updated 全量推送', async () => {
    const client = createMockClient();
    const { globalEvents } = runScript(client, '请设计 VQE 线路');
    const taskEvents = globalEvents.filter(
      (e): e is Extract<GlobalStreamEvent, { event: 'task.updated' }> =>
        e.event === 'task.updated',
    );
    expect(taskEvents.length).toBeGreaterThanOrEqual(4); // pending + 每步迁移
    // 定位 VQE 三步任务（尾声的 GPU 演示任务会晚于它推送）
    const vqeEvents = taskEvents.filter(
      (e) => e.data.steps.length === 3 && e.data.steps[1].kind === 'quantum',
    );
    expect(vqeEvents.length).toBeGreaterThanOrEqual(4);
    const final = vqeEvents[vqeEvents.length - 1];
    expect(final.data.status).toBe('succeeded');
    const steps = final.data.steps;
    expect(steps.map((s: Step) => s.kind)).toEqual(['classical', 'quantum', 'classical']);
    expect(steps[1].depends_on).toEqual([steps[0].id]);
    expect(steps[2].depends_on).toEqual([steps[1].id]);
    // §10：quantum 步占 qpu-quanta-20q，classical 步落 cpu-node-0
    expect(steps[0].node_id).toBe('cpu-node-0');
    expect(steps[1].node_id).toBe('qpu-quanta-20q');
    expect(steps[2].node_id).toBe('cpu-node-0');
  });

  it('hardware.updated：quantum 运行期 qpu 出现 allocation，完成后释放；尾步占 GPU 可回答归属', async () => {
    const client = createMockClient();
    const { globalEvents } = runScript(client, '请设计 VQE 线路');
    const hwEvents = globalEvents.filter((e) => e.event === 'hardware.updated');
    expect(hwEvents.length).toBeGreaterThanOrEqual(2);
    const qpuAt = (i: number): HardwareNode | undefined =>
      (hwEvents[i].event === 'hardware.updated'
        ? hwEvents[i].data.nodes
        : []
      ).find((n: HardwareNode) => n.id === 'qpu-quanta-20q');

    // 至少存在一帧：qpu 被 quantum 步占用（agent 可归属）
    const leasedFrame = hwEvents.findIndex(
      (_, i) => (qpuAt(i)?.allocations.length ?? 0) > 0,
    );
    expect(leasedFrame).toBeGreaterThanOrEqual(0);
    if (leasedFrame >= 0) {
      const alloc = qpuAt(leasedFrame)!.allocations[0];
      expect(alloc.agent_id).toBe('algorithm-designer');
      expect(alloc.task_id).toMatch(/^t-/);
      expect(alloc.step_id).toMatch(/^s-/);
    }
    // 末帧：qpu 租约已释放；演示 GPU 尾步（噪声表征）持有租约
    const lastIdx = hwEvents.length - 1;
    expect(qpuAt(lastIdx)?.allocations.length ?? 0).toBe(0);
    const gpuLeased = (hwEvents[lastIdx].event === 'hardware.updated'
      ? hwEvents[lastIdx].data.nodes
      : []
    ).some(
      (n: HardwareNode) =>
        n.kind === 'gpu' && n.allocations.some((a) => a.agent_id.length > 0),
    );
    expect(gpuLeased).toBe(true);
  });

  it('断线重连：close 后的事件在 after=<lastSeq> 重开时重放，seq 不回退', () => {
    const client = createMockClient();
    const seen: ConversationStreamEvent[] = [];
    const stream = client.openConversationStream('c-1', null, {
      onEvent: (e) => seen.push(e),
    });
    void client.sendMessage('c-1', '请设计 VQE 线路');
    vi.advanceTimersByTime(1_500); // 收到部分 delta 后断线
    stream.close();
    const lastSeq = Math.max(
      0,
      ...seen.filter((e) => e.event === 'message.delta').map((e) =>
        e.event === 'message.delta' ? e.data.seq : 0,
      ),
    );
    const replayed: ConversationStreamEvent[] = [];
    client.openConversationStream('c-1', lastSeq, {
      onEvent: (e) => replayed.push(e),
    });
    vi.advanceTimersByTime(20_000);
    expect(replayed.length).toBeGreaterThan(0);
    for (const e of replayed) {
      if (e.event === 'message.delta') expect(e.data.seq).toBeGreaterThan(lastSeq);
    }
    // 最终应包含 completed
    expect(replayed.some((e) => e.event === 'message.completed')).toBe(true);
  });

  it('GET 侧：fixtures 驱动 agents/conversations/hardware/tasks 全部面板', async () => {
    const client = createMockClient();
    const agents = await client.listAgents();
    expect(agents.map((a) => a.id).sort()).toEqual([
      'algorithm-designer',
      'calibration',
      'echo',
    ]);
    const { nodes } = await client.listHardware();
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes.some((n) => n.status === 'offline')).toBe(true);
    const convs = await client.listConversations();
    expect(convs.length).toBeGreaterThanOrEqual(2);
    const detail = await client.getConversation(convs[0].id);
    expect(detail.messages.length).toBeGreaterThanOrEqual(2);
    const tasks = await client.listTasks(convs[0].id);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });
});
