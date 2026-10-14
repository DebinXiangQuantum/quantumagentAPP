/**
 * appStore.test.ts —— 数据 store 的可观察行为测试（用 Mock 引擎驱动）。
 *
 * 覆盖：
 *  1. bootstrap：agents/tenant/会话/硬件/任务全部落库，自动选中首个会话并
 *     挂载消息；连接灯 online；
 *  2. sendMessage：用户消息即时上屏（202 语义）→ SSE delta 累积为流式消息 →
 *     completed 后转完整消息（含 artifacts），流式态清除；
 *  3. task.updated upsert（未知 task 以事件包络合成）、hardware.updated 更新
 *     节点并滚动记录利用率历史（60s 窗口 cap）；
 *  4. v1.2 自动建会话三分支：无活跃会话直发自动建会话（标题=前 20 字）、
 *     404 自动重建重试一次、非 404 失败 sendError/failedDraft + retrySend。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';
import { setApi } from '../api';
import { createMockClient, type MockClient } from '../api/mock/engine';
import { ApiError } from '../api/client';
import type { Artifact, AttachmentMeta, Conversation, Message } from '../types/domain';
import type { ConversationStreamEvent } from '../types/events';

describe('useAppStore（Mock 引擎驱动）', () => {
  let client: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
    setApi(client);
    useAppStore.getState().resetForTest();
  });
  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it('bootstrap 加载全部面板数据并连接流', async () => {
    await useAppStore.getState().bootstrap();
    const s = useAppStore.getState();
    expect(s.booted).toBe(true);
    expect(s.bootError).toBeNull();
    expect(s.agents.map((a) => a.id)).toContain('algorithm-designer');
    expect(s.tenant?.id).toBe('demo');
    expect(s.conversations.length).toBeGreaterThanOrEqual(2);
    expect(s.activeConversationId).toBe(s.conversations[0].id);
    expect(s.messagesByCid[s.activeConversationId!].length).toBeGreaterThanOrEqual(2);
    expect(s.hardwareNodes.length).toBeGreaterThanOrEqual(4);
    expect(s.tasks.length).toBeGreaterThanOrEqual(2);
    expect(s.connection).toBe('online');
  });

  it('bootstrap 失败可重试（bootError + retryBootstrap）', async () => {
    let failed = true;
    const flaky = {
      ...client,
      async listAgents() {
        if (failed) throw new Error('backend down');
        return client.listAgents();
      },
    };
    setApi(flaky);
    await useAppStore.getState().bootstrap();
    expect(useAppStore.getState().booted).toBe(false);
    expect(useAppStore.getState().bootError).toBeTruthy();
    failed = false;
    await useAppStore.getState().retryBootstrap();
    expect(useAppStore.getState().booted).toBe(true);
  });

  it('sendMessage 全链路：用户消息上屏 → 流式累积 → completed 落库', async () => {
    await useAppStore.getState().bootstrap();
    const cid = useAppStore.getState().activeConversationId!;
    const before = useAppStore.getState().messagesByCid[cid].length;
    const sendP = useAppStore.getState().sendMessage('请设计 VQE 线路');
    await vi.advanceTimersByTimeAsync(600);
    // 用户消息已即时上屏（202 语义：不等 SSE）
    expect(useAppStore.getState().messagesByCid[cid].length).toBe(before + 1);
    // 流式累积中
    const streaming = useAppStore.getState().streamingByCid[cid];
    expect(streaming).toBeDefined();
    expect((streaming?.text.length ?? 0)).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2_000);
    // completed 已发生：流式态清除，assistant 消息带 artifacts
    const s = useAppStore.getState();
    expect(s.streamingByCid[cid]).toBeUndefined();
    const msgs = s.messagesByCid[cid];
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.artifacts.map((a) => a.type).sort()).toEqual(['circuit', 'counts']);
    await sendP;
  });

  it('task.updated upsert 新任务；hardware.updated 更新节点与利用率历史', async () => {
    await useAppStore.getState().bootstrap();
    const s1 = useAppStore.getState();
    const hist0 = (s1.utilHistoryByNode['qpu-quanta-20q'] ?? []).length;
    await vi.advanceTimersByTimeAsync(4_500);
    const s2 = useAppStore.getState();
    // 脚本提交的新任务（t-10x）经全局流 upsert
    expect(s2.tasks.some((t) => t.status === 'running' || t.status === 'succeeded')).toBe(
      true,
    );
    // 利用率历史随 tick 滚动（cap 30 = 60s / 2s）
    expect(s2.utilHistoryByNode['qpu-quanta-20q'].length).toBeGreaterThan(hist0);
    expect(
      s2.utilHistoryByNode['qpu-quanta-20q'].length,
    ).toBeLessThanOrEqual(30);
  });
});

/** v1.2 自动建会话三分支（design.md §5）：无会话直发 / 404 重建重试一次 / 失败内联重试。 */
describe('sendMessage 自动建会话（v1.2）', () => {
  const conv = (id: string, title: string): Conversation => ({
    id,
    title,
    agent_id: 'orchestrator',
    tenant_id: 'demo',
    created_at: '2026-10-13T09:00:00Z',
  });
  /** 构造可编程 API 桩：create/send 行为按用例注入。 */
  function stubApi(overrides: {
    create?: (req: { title?: string }) => Promise<Conversation>;
    send?: (cid: string, content: string) => Promise<{ message_id: string; run_id: string }>;
  }): void {
    const base = createMockClient();
    setApi({
      ...base,
      createConversation: overrides.create ?? base.createConversation.bind(base),
      sendMessage:
        overrides.send ??
        (async (cid: string) => ({ message_id: `m-${cid}`, run_id: 'r-1' })),
      // 自动建会话测试不订阅流，避免脚本定时器干扰断言
      openConversationStream: () => ({ close: () => undefined }),
      openGlobalStream: () => ({ close: () => undefined }),
    } as never);
  }

  it('分支一：无活跃会话直发 → 自动建会话（标题=消息前 20 字）→ 发送到新会话', async () => {
    const created: Array<{ title?: string }> = [];
    const sentTo: string[] = [];
    stubApi({
      create: async (req) => {
        created.push({ title: req.title });
        return conv('c-new', req.title ?? '');
      },
      send: async (cid) => {
        sentTo.push(cid);
        return { message_id: 'm-9', run_id: 'r-9' };
      },
    });
    useAppStore.getState().resetForTest();
    useAppStore.setState({ activeConversationId: null, conversations: [] });

    await useAppStore.getState().sendMessage('估算 H2 基态能量并给出线路与计数结果');

    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('估算 H2 基态能量并给出线路与计数结果'.slice(0, 20));
    expect(sentTo).toEqual(['c-new']);
    expect(useAppStore.getState().activeConversationId).toBe('c-new');
    // 乐观用户消息落在新建会话中
    const msgs = useAppStore.getState().messagesByCid['c-new'];
    expect(msgs?.some((m) => m.role === 'user' && m.content.includes('H2'))).toBe(true);
    expect(useAppStore.getState().sendError).toBeNull();
  });

  it('分支二：发送返回 404 → 自动新建会话并重试一次成功', async () => {
    let sendCalls = 0;
    stubApi({
      create: async (req) => conv('c-reborn', req.title ?? 'T'),
      send: async (cid) => {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw new ApiError(404, '会话不存在（后端重启）', null);
        }
        expect(cid).toBe('c-reborn');
        return { message_id: 'm-10', run_id: 'r-10' };
      },
    });
    useAppStore.getState().resetForTest();
    useAppStore.setState({
      activeConversationId: 'c-gone',
      conversations: [conv('c-gone', '旧会话')],
      messagesByCid: {},
    });

    await useAppStore.getState().sendMessage('继续 VQE 优化');

    expect(sendCalls).toBe(2); // 404 → 新建 → 重试一次
    expect(useAppStore.getState().activeConversationId).toBe('c-reborn');
    expect(useAppStore.getState().sendError).toBeNull();
  });

  it('分支三：非 404 失败 → sendError + failedDraft；retrySend 重新发送成功', async () => {
    let fail = true;
    const sentContents: string[] = [];
    stubApi({
      send: async (_cid, content) => {
        sentContents.push(content);
        if (fail) throw new ApiError(429, '超出当日配额', 30);
        return { message_id: 'm-11', run_id: 'r-11' };
      },
    });
    useAppStore.getState().resetForTest();
    useAppStore.setState({ activeConversationId: 'c-1', conversations: [conv('c-1', 'T')], messagesByCid: {} });

    await useAppStore.getState().sendMessage('设计 QAOA 线路');
    expect(useAppStore.getState().sendError).toContain('429');
    expect(useAppStore.getState().failedDraft?.content).toBe('设计 QAOA 线路');
    // 失败：用户消息不上屏（未确认发送成功）
    expect(useAppStore.getState().messagesByCid['c-1']?.length ?? 0).toBe(0);

    fail = false;
    await useAppStore.getState().retrySend();
    expect(sentContents).toEqual(['设计 QAOA 线路', '设计 QAOA 线路']);
    expect(useAppStore.getState().sendError).toBeNull();
    expect(useAppStore.getState().failedDraft).toBeNull();
    expect(useAppStore.getState().messagesByCid['c-1']?.length).toBe(1);
  });

  it('发送中态：sending 置位期间重复调用被忽略', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sends: string[] = [];
    stubApi({
      send: async (_cid, content) => {
        sends.push(content);
        await gate;
        return { message_id: 'm-12', run_id: 'r-12' };
      },
    });
    useAppStore.getState().resetForTest();
    useAppStore.setState({ activeConversationId: 'c-1', conversations: [conv('c-1', 'T')], messagesByCid: {} });

    const first = useAppStore.getState().sendMessage('第一条');
    await Promise.resolve();
    expect(useAppStore.getState().sending).toBe(true);
    await useAppStore.getState().sendMessage('第二条'); // sending 中 → 静默忽略
    release();
    await first;
    expect(sends).toEqual(['第一条']);
    expect(useAppStore.getState().sending).toBe(false);
  });
});

/** v1.3：sendMessage 携带 attachment_ids（空数组不携带，保持既有 POST body 断言兼容）。 */
describe('sendMessage 附件参数（v1.3）', () => {
  it('attachment_ids 非空时进入 POST body；attachments 元数据随乐观用户消息上屏', async () => {
    const sendSpy = vi.fn(async () => ({ message_id: 'm-20', run_id: 'r-20' }));
    const base = createMockClient();
    setApi({
      ...base,
      sendMessage: sendSpy,
      openConversationStream: () => ({ close: () => undefined }),
      openGlobalStream: () => ({ close: () => undefined }),
    } as never);
    useAppStore.getState().resetForTest();
    useAppStore.setState({ activeConversationId: 'c-1', messagesByCid: {} });

    const meta: AttachmentMeta = {
      id: 'att-9',
      name: '数据.csv',
      mime: 'text/csv',
      size: 1024,
      kind: 'text',
    };
    await useAppStore.getState().sendMessage('分析这个', {
      attachmentIds: ['att-9'],
      attachments: [meta],
    });
    expect(sendSpy).toHaveBeenCalledWith(
      'c-1',
      '分析这个',
      expect.objectContaining({ attachment_ids: ['att-9'] }),
    );
    const msg = useAppStore.getState().messagesByCid['c-1'][0];
    expect(msg.attachments).toEqual([meta]);
  });
});

/**
 * v1.4 事件归并：agent.activity（按 message_id 聚合到 subagentActivityByMessage）
 * 与 artifact.created（即时插卡：未 completed → 流式临时 artifacts；
 * completed → 就地追加/全量覆盖去重）；seq 单调门控（乱序/重复丢弃）。
 */
describe('v1.4 agent.activity / artifact.created 归并', () => {
  let emit: ((e: ConversationStreamEvent) => void) | null = null;

  beforeEach(() => {
    const base = createMockClient();
    setApi({
      ...base,
      // 可编程流：捕获 onEvent 供测试注入合成事件（不发真实脚本）
      openConversationStream: (
        _cid: string,
        _after: number | null,
        cb: { onEvent: (e: ConversationStreamEvent) => void },
      ) => {
        emit = cb.onEvent;
        return { close: () => undefined };
      },
      openGlobalStream: () => ({ close: () => undefined }),
    } as never);
    useAppStore.getState().resetForTest();
    useAppStore.setState({
      activeConversationId: 'c-1',
      conversations: [
        {
          id: 'c-1',
          title: 'T',
          agent_id: 'orchestrator',
          tenant_id: 'demo',
          created_at: '2026-10-14T09:00:00Z',
        },
      ],
      messagesByCid: { 'c-1': [] },
      loadedCids: { 'c-1': true },
    });
    // selectConversation 已在 resetForTest 后重放：手动打开流（emit 已捕获）
    useAppStore.getState().selectConversation('c-1');
  });
  afterEach(() => {
    emit = null;
  });

  const activity = (seq: number, phase: string, extra: Record<string, unknown> = {}): void => {
    emit?.({
      event: 'agent.activity',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        agent_id: 'algorithm-designer',
        phase,
        seq,
        ...extra,
      } as never,
    });
  };

  const lastMessage = (): Message => {
    const list = useAppStore.getState().messagesByCid['c-1'];
    return list[list.length - 1];
  };

  it('dispatch_started 创建聚合条目；delta 增量按顺序拼接', () => {
    activity(1, 'dispatch_started');
    activity(2, 'reasoning_delta', { delta: '分析问题…' });
    activity(3, 'reasoning_delta', { delta: '选择 ansatz。' });
    activity(4, 'text_delta', { delta: '正在合成线路' });
    let entry = useAppStore.getState().subagentActivityByMessage['m-a'];
    expect(entry).toHaveLength(1);
    expect(entry![0]).toEqual({
      agentId: 'algorithm-designer',
      phase: 'text_delta',
      text: '分析问题…选择 ansatz。正在合成线路',
      tools: [],
    });
    activity(5, 'dispatch_completed');
    entry = useAppStore.getState().subagentActivityByMessage['m-a'];
    expect(entry![0].phase).toBe('dispatch_completed');
    // 收束后 text/tools 保持（摘要行可回看）
    expect(entry![0].text).toBe('分析问题…选择 ansatz。正在合成线路');
  });

  it('tool_call 追加工具名（多次调用按序保留）', () => {
    activity(1, 'dispatch_started');
    activity(2, 'tool_call', { tool: 'query_hardware' });
    activity(3, 'tool_call', { tool: 'emit_artifact' });
    activity(4, 'tool_call', { tool: 'query_hardware' });
    const entry = useAppStore.getState().subagentActivityByMessage['m-a']!;
    expect(entry[0].tools).toEqual(['query_hardware', 'emit_artifact', 'query_hardware']);
  });

  it('多个专家同消息并存（按 agentId 聚合互不串扰）', () => {
    activity(1, 'dispatch_started');
    emit?.({
      event: 'agent.activity',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        agent_id: 'calibration',
        phase: 'dispatch_started',
        seq: 2,
      },
    });
    activity(3, 'text_delta', { delta: 'A 输出' });
    emit?.({
      event: 'agent.activity',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        agent_id: 'calibration',
        phase: 'text_delta',
        delta: 'C 输出',
        seq: 4,
      },
    });
    const entry = useAppStore.getState().subagentActivityByMessage['m-a']!;
    expect(entry).toHaveLength(2);
    expect(entry.find((e) => e.agentId === 'algorithm-designer')?.text).toBe('A 输出');
    expect(entry.find((e) => e.agentId === 'calibration')?.text).toBe('C 输出');
  });

  it('seq 乱序/重复事件被丢弃（乱序不污染增量拼接）', () => {
    activity(5, 'dispatch_started');
    activity(6, 'text_delta', { delta: '正确顺序' });
    activity(3, 'text_delta', { delta: '迟到旧包' }); // seq 回退 → 丢弃
    activity(6, 'text_delta', { delta: '重复 seq' }); // 与已见 seq 相等 → 丢弃
    activity(7, 'text_delta', { delta: '·新包' });
    const entry = useAppStore.getState().subagentActivityByMessage['m-a']!;
    expect(entry[0].text).toBe('正确顺序·新包');
  });

  it('artifact.created（未 completed）→ 插入流式消息临时 artifacts', () => {
    emit?.({
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-a', delta: '合成中', seq: 1 },
    });
    emit?.({
      event: 'artifact.created',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        artifact: { id: 'a-90', type: 'circuit', title: 'Ansatz', payload: { qubits: 2, operations: [] } },
      },
    });
    const streaming = useAppStore.getState().streamingByCid['c-1'];
    expect((streaming?.artifacts ?? []).map((a) => a.id)).toEqual(['a-90']);
    // 同 id 重复推送 → 去重
    emit?.({
      event: 'artifact.created',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        artifact: { id: 'a-90', type: 'circuit', title: 'Ansatz', payload: { qubits: 2, operations: [] } },
      },
    });
    expect(useAppStore.getState().streamingByCid['c-1']?.artifacts).toHaveLength(1);
  });

  it('completed 用事件携带 artifacts 全量覆盖临时卡（不做双份）', () => {
    emit?.({
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-a', delta: '合成中', seq: 1 },
    });
    const art: Artifact = { id: 'a-90', type: 'circuit', title: 'Ansatz', payload: null };
    emit?.({
      event: 'artifact.created',
      data: { conversation_id: 'c-1', message_id: 'm-a', artifact: art },
    });
    emit?.({
      event: 'message.completed',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        artifacts: [art, { id: 'a-91', type: 'counts', title: '计数', payload: null }],
        reasoning: '',
      },
    });
    const s = useAppStore.getState();
    expect(s.streamingByCid['c-1']).toBeUndefined();
    const last = s.messagesByCid['c-1'][s.messagesByCid['c-1'].length - 1];
    expect(last.id).toBe('m-a');
    expect(last.artifacts.map((a) => a.id)).toEqual(['a-90', 'a-91']);
  });

  it('completed 之后再收到 artifact.created → 就地追加进已完成消息（去重）', () => {
    emit?.({
      event: 'message.completed',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        artifacts: [{ id: 'a-1', type: 'circuit', title: 'x', payload: null }],
        reasoning: '',
      },
    });
    emit?.({
      event: 'artifact.created',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        artifact: { id: 'a-2', type: 'counts', title: 'y', payload: null },
      },
    });
    let last = lastMessage();
    expect(last.artifacts.map((a) => a.id)).toEqual(['a-1', 'a-2']);
    emit?.({
      event: 'artifact.created',
      data: {
        conversation_id: 'c-1',
        message_id: 'm-a',
        artifact: { id: 'a-2', type: 'counts', title: 'y', payload: null },
      },
    });
    last = lastMessage();
    expect(last.artifacts).toHaveLength(2);
  });

  it('message.delta 同样受 seq 门控：乱序旧包不拼接', () => {
    emit?.({
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-a', delta: '第一段', seq: 10 },
    });
    emit?.({
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-a', delta: '旧包', seq: 9 },
    });
    expect(useAppStore.getState().streamingByCid['c-1']?.text).toBe('第一段');
  });
});
