/**
 * ChatPanel.test.tsx —— 对话区整体渲染测试。
 *
 * 覆盖：
 *  1. 用户消息右对齐气泡 / 助手左对齐分组（class 断言）；
 *  2. 助手组首条带头像、组间有分隔线；
 *  3. 流式消息渲染 + 闪烁光标存在；
 *  4. 空会话显示插画式空态。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import { useAppStore } from '../../store/appStore';
import type { Message } from '../../types/domain';

function msg(partial: Partial<Message> & { id: string; role: Message['role'] }): Message {
  return {
    conversation_id: 'c-1',
    content: '',
    agent_id: 'algorithm-designer',
    artifacts: [],
    created_at: '2026-10-13T08:00:00Z',
    ...partial,
  };
}

describe('ChatPanel', () => {
  it('用户右对齐气泡、助手左对齐；助手组带头像、组间分隔', () => {
    useAppStore.setState({
      activeConversationId: 'c-1',
      conversations: [
        {
          id: 'c-1',
          title: 'T',
          agent_id: 'algorithm-designer',
          tenant_id: 'demo',
          created_at: '2026-10-13T08:00:00Z',
        },
      ],
      messagesByCid: {
        'c-1': [
          msg({ id: 'm-1', role: 'user', content: '用户一' }),
          msg({ id: 'm-2', role: 'assistant', content: '助手一' }),
          msg({ id: 'm-3', role: 'assistant', content: '助手二' }),
          msg({ id: 'm-4', role: 'user', content: '用户二' }),
        ],
      },
      streamingByCid: {},
      loadedCids: { 'c-1': true },
    });
    render(<ChatPanel />);
    const flow = screen.getByTestId('message-flow');
    expect(within(flow).getByText('用户一').closest('.message--user')).not.toBeNull();
    expect(within(flow).getByText('助手一').closest('.message--assistant')).not.toBeNull();
    // 助手组首条（m-2）带头像；m-3 同组为 ghost 占位不计
    const avatars = flow.querySelectorAll(
      '.message__avatar:not(.message__avatar--ghost)',
    );
    expect(avatars.length).toBe(1);
    // 角色切换处有分隔线（user→assistant、assistant→user）
    expect(flow.querySelectorAll('.message-group-sep').length).toBe(2);
  });

  it('流式消息渲染并带闪烁光标', () => {
    useAppStore.setState({
      activeConversationId: 'c-1',
      conversations: [
        {
          id: 'c-1',
          title: 'T',
          agent_id: 'algorithm-designer',
          tenant_id: 'demo',
          created_at: '2026-10-13T08:00:00Z',
        },
      ],
      messagesByCid: { 'c-1': [] },
      streamingByCid: { 'c-1': { messageId: 'm-9', text: '正在生成' } },
      loadedCids: { 'c-1': true },
    });
    render(<ChatPanel />);
    expect(screen.getByText('正在生成')).toBeInTheDocument();
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument();
  });

  it('空会话显示空态文案与输入区并存', () => {
    useAppStore.setState({
      activeConversationId: 'c-1',
      conversations: [
        {
          id: 'c-1',
          title: 'T',
          agent_id: 'echo',
          tenant_id: 'demo',
          created_at: '2026-10-13T08:00:00Z',
        },
      ],
      messagesByCid: { 'c-1': [] },
      streamingByCid: {},
      loadedCids: { 'c-1': true },
    });
    render(<ChatPanel />);
    expect(screen.getByText(/发送第一条消息/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('无激活会话时显示引导创建空态', () => {
    useAppStore.setState({
      activeConversationId: null,
      conversations: [],
      messagesByCid: {},
      streamingByCid: {},
    });
    render(<ChatPanel />);
    expect(screen.getByText(/暂无会话/)).toBeInTheDocument();
  });
});
