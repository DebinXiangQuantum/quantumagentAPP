/**
 * appStore.test.ts —— 数据 store 的可观察行为测试（用 Mock 引擎驱动）。
 *
 * 覆盖：
 *  1. bootstrap：agents/tenant/会话/硬件/任务全部落库，自动选中首个会话并
 *     挂载消息；连接灯 online；
 *  2. sendMessage：用户消息即时上屏（202 语义）→ SSE delta 累积为流式消息 →
 *     completed 后转完整消息（含 artifacts），流式态清除；
 *  3. task.updated upsert（未知 task 以事件包络合成）、hardware.updated 更新
 *     节点并滚动记录利用率历史（60s 窗口 cap）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';
import { setApi } from '../api';
import { createMockClient, type MockClient } from '../api/mock/engine';

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
