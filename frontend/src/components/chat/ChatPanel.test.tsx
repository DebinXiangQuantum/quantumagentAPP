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
import type { SubagentActivity } from '../../store/appStore';
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

  it('v1.5 流式正文走 Markdown 管线：加粗/公式渲染；半截表格不崩溃', () => {
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
      // 流式中段：加粗已完成、公式行内闭合、表格仅到一半（真实增量形态）
      streamingByCid: {
        'c-1': {
          messageId: 'm-9',
          text: '**收敛中**，当前 $E_0 \\approx -1.13$：\n\n| 参数 | 值 |\n|---|---|\n| θ₀',
        },
      },
      loadedCids: { 'c-1': true },
    });
    expect(() => render(<ChatPanel />)).not.toThrow();
    const bubble = document.querySelector('.message--streaming .message__text');
    expect(bubble?.querySelector('strong')).toHaveTextContent('收敛中');
    expect(bubble?.querySelector('.katex')).not.toBeNull();
    expect(bubble?.querySelector('.md-table-wrap')).not.toBeNull();
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

/** v1.4：专家工作区在流式气泡与已完成气泡内嵌渲染（agent.activity 聚合数据）。 */
describe('ChatPanel 专家工作区（v1.4）', () => {
  function seedWith(activityState: Record<string, SubagentActivity[]>): void {
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
      messagesByCid: {
        'c-1': [msg({ id: 'm-2', role: 'assistant', content: '已完成回复' })],
      },
      streamingByCid: {},
      subagentActivityByMessage: activityState,
      loadedCids: { 'c-1': true },
      agents: [
        {
          id: 'algorithm-designer',
          name: '量子算法设计',
          description: '',
          capabilities: [],
          model_ref: 'glm-5.3',
          builtin: true,
        },
      ],
    });
  }

  it('已完成消息：工作区折叠为摘要行，agents 注册表解析专家显示名', () => {
    seedWith({
      'm-2': [
        {
          agentId: 'algorithm-designer',
          phase: 'dispatch_completed',
          reasoning: '',
          timeline: [],
          text: '已完成合成。',
          toolCalls: [{ name: 'query_hardware', arguments: '{}' }, { name: 'emit_artifact', arguments: '{}' }],
        },
      ],
    });
    render(<ChatPanel />);
    const ws = screen.getByTestId('subagent-workspace-algorithm-designer');
    expect(ws).toHaveTextContent('量子算法设计');
    expect(ws.getAttribute('aria-expanded')).toBe('false');
    expect(ws).toHaveTextContent('已完成'); // v1.10 格式变更
  });

  it('流式消息：工作区运行中展开（含工具行），随流式气泡渲染', () => {
    seedWith({
      'm-9': [
        {
          agentId: 'calibration',
          phase: 'text_delta',
          reasoning: '',
          timeline: [],
          text: '正在合成 DRAG 脉冲',
          toolCalls: [{ name: 'query_hardware', arguments: '{}' }],
        },
      ],
    });
    useAppStore.setState({
      messagesByCid: { 'c-1': [] },
      streamingByCid: { 'c-1': { messageId: 'm-9', text: '正文等待中' } },
    });
    render(<ChatPanel />);
    const ws = screen.getByTestId('subagent-workspace-calibration');
    expect(ws.getAttribute('data-running')).toBe('true');
    expect(ws.getAttribute('aria-expanded')).toBe('true');
    expect(ws).toHaveTextContent('正在合成 DRAG 脉冲');
    expect(screen.getAllByTestId(/^subagent-tool-line-/).length).toBe(1);
    // 未注册专家 → 回退原始 id
    expect(ws).toHaveTextContent('calibration');
  });
});

/** v1.4：artifact.created 流式临时卡（骨架态）在流式气泡内即时渲染。 */
describe('ChatPanel 流式 artifact 插卡（v1.4）', () => {
  it('streaming.artifacts 非空 → 流式气泡渲染骨架卡（artifact-card--streaming）', () => {
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
      streamingByCid: {
        'c-1': {
          messageId: 'm-9',
          text: '正在合成线路',
          artifacts: [
            { id: 'a-90', type: 'circuit', title: 'Ansatz（生成中）', payload: null },
          ],
        },
      },
      subagentActivityByMessage: {},
      loadedCids: { 'c-1': true },
    });
    render(<ChatPanel />);
    const card = screen.getByTestId('artifact-card');
    expect(card).toHaveClass('artifact-card--streaming');
    expect(card).toHaveTextContent('Ansatz（生成中）');
    // 流式气泡与正文共存
    expect(screen.getByText('正在合成线路')).toBeInTheDocument();
  });
});
