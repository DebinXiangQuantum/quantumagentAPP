/**
 * ReasoningBlock.test.tsx —— v1.1 思考过程展示测试（design.md §5）。
 *
 * 覆盖：
 *  1. 折叠块：默认收起（摘要一行 + 字数），点击展开（chevron 旋转类）；
 *  2. 展开正文：mono/caption（class 断言）+ 思考全文；
 *  3. 流式 active 态：摘要显示「思考中…」，正文末尾有流式光标；
 *  4. MessageBubble：reasoning 非空的助手消息顶部渲染折叠块；空则不渲染；
 *  5. store 归并：message.reasoning 增量独立缓冲（与正文 delta 互不污染），
 *     completed 后并入 Message.reasoning（增量拼接 == 事件全文）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReasoningBlock } from './ReasoningBlock';
import { MessageBubble } from './MessageBubble';
import { ChatPanel } from './ChatPanel';
import { useAppStore } from '../../store/appStore';
import { setApi } from '../../api';
import { createFakeApi, type FakeApiClient } from '../../test/fakeApi';
import type { Message } from '../../types/domain';

const REASONING =
  '用户请求估算 H2 基态能量。\n计划：dispatch_agent("algorithm-designer")，\n以 STO-3G 建模并合成硬件高效 Ansatz。';

function msg(partial: Partial<Message> & { id: string }): Message {
  return {
    conversation_id: 'c-1',
    role: 'assistant',
    content: '正文',
    agent_id: 'orchestrator',
    artifacts: [],
    created_at: '2026-10-13T08:00:00Z',
    ...partial,
  };
}

describe('ReasoningBlock（折叠交互）', () => {
  it('默认收起：摘要一行（字数）+ chevron；点击展开显示全文', () => {
    render(<ReasoningBlock reasoning={REASONING} />);
    const block = screen.getByTestId('reasoning-block');
    const header = screen.getByRole('button', { name: /思考过程/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // 摘要含字数（Array.from 计数）
    expect(block.textContent).toContain('字');
    // 展开前正文不可见
    expect(screen.queryByText(/STO-3G/)).toBeNull();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/STO-3G/)).toBeInTheDocument();
    expect(block.querySelector('.reasoning__text')).toHaveClass('mono');
    expect(block.querySelector('.reasoning__chevron')).toHaveClass(
      'reasoning__chevron--open',
    );
  });

  it('流式 active：摘要「思考中…」；展开后思考正文末尾有流式光标', () => {
    render(<ReasoningBlock reasoning="思考片段…" active />);
    expect(screen.getByText('思考中…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }));
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument();
  });

  it('reasoning 为空且非 active → 不渲染', () => {
    const { container } = render(<ReasoningBlock reasoning="" />);
    expect(container.querySelector('.reasoning')).toBeNull();
  });
});

describe('MessageBubble（思考块挂载）', () => {
  it('reasoning 非空的助手消息顶部渲染思考折叠块；用户消息/空 reasoning 不渲染', () => {
    const { rerender } = render(<MessageBubble message={msg({ id: 'm-1', reasoning: REASONING })} />);
    expect(screen.getByTestId('reasoning-block')).toBeInTheDocument();

    rerender(<MessageBubble message={msg({ id: 'm-1', reasoning: '' })} />);
    expect(screen.queryByTestId('reasoning-block')).toBeNull();

    rerender(<MessageBubble message={msg({ id: 'm-1', role: 'user' })} />);
    expect(screen.queryByTestId('reasoning-block')).toBeNull();
  });
});

describe('store 归并（message.reasoning SSE，fakeApi 脚本驱动）', () => {
  let client: FakeApiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createFakeApi();
    // 时间轴：100 思考增量 → 600 正文 delta → 1800 completed
    // （契约 §7：reasoning 先于正文 delta 到达）
    client.setSendScript(() => [
      {
        atMs: 100,
        run: (c) =>
          c.emitConversation({
            event: 'message.reasoning',
            data: {
              conversation_id: c.cid,
              message_id: c.assistantMessageId,
              delta: '计划：dispatch_agent("algorithm-designer")，以 STO-3G 建模。',
            },
          } as never),
      },
      {
        atMs: 500,
        run: (c) =>
          c.emitConversation({
            event: 'message.delta',
            data: { conversation_id: c.cid, message_id: c.assistantMessageId, delta: '正在合成 Ansatz' },
          } as never),
      },
      {
        atMs: 1200,
        run: (c) =>
          c.emitConversation({
            event: 'message.completed',
            data: {
              conversation_id: c.cid,
              message_id: c.assistantMessageId,
              reasoning: '计划：dispatch_agent("algorithm-designer")，以 STO-3G 建模。',
              artifacts: [],
            },
          } as never),
      },
    ]);
    setApi(client);
    useAppStore.getState().resetForTest();
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it('先思考后正文：思考增量独立缓冲（正文未到时 text 空）；completed 后增量==全文并入 Message', async () => {
    await useAppStore.getState().bootstrap();
    const cid = useAppStore.getState().activeConversationId!;
    const sendP = useAppStore.getState().sendMessage('请设计 VQE 线路');

    // 350ms：思考增量已到、正文未到（契约 §7：reasoning 先于正文）
    await vi.advanceTimersByTimeAsync(350);
    let streaming = useAppStore.getState().streamingByCid[cid];
    expect(streaming).toBeDefined();
    expect((streaming?.reasoning ?? '').length).toBeGreaterThan(0);
    expect(streaming?.text ?? '').toBe('');

    // 900ms：正文流式中（思考与正文共存于同一缓冲对象）
    await vi.advanceTimersByTimeAsync(550);
    streaming = useAppStore.getState().streamingByCid[cid];
    expect((streaming?.reasoning ?? '').length).toBeGreaterThan(0);
    expect((streaming?.text ?? '').length).toBeGreaterThan(0);

    // 完成：Message.reasoning == 流式思考缓冲（增量拼接 == 全文）
    await vi.advanceTimersByTimeAsync(2_500);
    const s = useAppStore.getState();
    expect(s.streamingByCid[cid]).toBeUndefined();
    const last = s.messagesByCid[cid][s.messagesByCid[cid].length - 1];
    expect(last.role).toBe('assistant');
    expect(last.reasoning).toContain('dispatch_agent');
    expect((last.reasoning ?? '').length).toBeGreaterThan(0);
    await sendP;
  });

  it('ChatPanel 流式态：正文未到显示「思考中…」；思考块实时存在', async () => {
    await useAppStore.getState().bootstrap();
    const view = render(<ChatPanel />);
    const sendP = useAppStore.getState().sendMessage('请设计 VQE 线路');
    await vi.advanceTimersByTimeAsync(350);
    // 正文未到：消息文本区显示「思考中…」（折叠块摘要同名，二者并存）
    expect(document.querySelector('.message__thinking')?.textContent).toBe('思考中…');
    expect(screen.getAllByTestId('reasoning-block').length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(4_000);
    // 完成后：思考中态消失；历史消息带思考折叠块（默认收起）
    expect(document.querySelector('.message__thinking')).toBeNull();
    expect(screen.getAllByTestId('reasoning-block').length).toBeGreaterThan(0);
    await sendP;
    view.unmount();
  });
});
