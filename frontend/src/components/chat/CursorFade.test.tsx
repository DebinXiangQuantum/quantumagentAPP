/**
 * CursorFade.test.tsx —— 流式光标完成淡出测试（design.md §7）。
 *
 * 覆盖：streaming → completed 转换后，光标以淡出类再存在一拍（120ms 后卸载）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import { useAppStore } from '../../store/appStore';
import type { Message } from '../../types/domain';

const CONV = {
  id: 'c-1',
  title: 'T',
  agent_id: 'algorithm-designer',
  tenant_id: 'demo',
  created_at: '2026-10-13T08:00:00Z',
};

const ASSISTANT: Message = {
  id: 'm-9',
  conversation_id: 'c-1',
  role: 'assistant',
  content: '完整回复',
  agent_id: 'algorithm-designer',
  artifacts: [],
  created_at: '2026-10-13T08:01:00Z',
};

describe('流式光标完成淡出', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completed 后光标先以淡出类存在，随后卸载', () => {
    useAppStore.setState({
      activeConversationId: 'c-1',
      conversations: [CONV],
      messagesByCid: { 'c-1': [ASSISTANT] },
      streamingByCid: { 'c-1': { messageId: 'm-9', text: '完整回复' } },
      loadedCids: { 'c-1': true },
    });
    render(<ChatPanel />);
    expect(screen.getByTestId('streaming-cursor')).not.toHaveClass(
      'streaming-cursor--fade',
    );
    // 模拟 message.completed：流式态清除、消息已入库（act 刷新受控更新）
    act(() => {
      useAppStore.setState({ streamingByCid: {} });
    });
    expect(screen.getByTestId('streaming-cursor')).toHaveClass(
      'streaming-cursor--fade',
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId('streaming-cursor')).toBeNull();
  });
});
