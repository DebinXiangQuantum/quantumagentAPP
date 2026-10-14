/**
 * SubagentWorkspace.test.tsx —— v1.4 专家工作区渐进块测试（design.md §5 v1.4）。
 *
 * 覆盖：
 *  1. 运行中（phase != dispatch_completed）：默认展开——头部（专家名 +
 *     运行中徽标 data-running=true）+ 流式文本（reasoning/text 增量合并）+
 *     工具行「→ 调用工具 <name>」（计数 == tools.length）；
 *  2. dispatch_completed：自动折叠为摘要行「专家已完成 · 输出 N 字 · 工具
 *     M 次」；点击头部可展开回看全程（文本与工具行保留）；
 *  3. 畸形输入（空 text/tools）不崩溃——仅头部 + 运行徽标；
 *  4. agentId 回退：未提供 agentName 时头部显示原始 agent_id。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SubagentWorkspace } from './SubagentWorkspace';
import type { SubagentActivity } from '../../store/appStore';

const RUNNING: SubagentActivity = {
  agentId: 'algorithm-designer',
  phase: 'text_delta',
  text: '问题已建模，正在合成硬件高效 Ansatz…',
  tools: ['query_hardware', 'emit_artifact'],
};

const DONE: SubagentActivity = {
  agentId: 'algorithm-designer',
  phase: 'dispatch_completed',
  text: '合成完成，线路 6 个门。',
  tools: ['query_hardware'],
};

describe('SubagentWorkspace（v1.4 专家工作区）', () => {
  it('运行中默认展开：专家名 + 运行中徽标 + 流式文本 + 工具行计数', () => {
    render(<SubagentWorkspace activity={RUNNING} agentName="量子算法设计" />);
    const ws = screen.getByTestId('subagent-workspace-algorithm-designer');
    expect(ws.getAttribute('data-running')).toBe('true');
    expect(ws).toHaveTextContent('量子算法设计');
    expect(screen.getByTestId('subagent-running-badge')).toBeTruthy();
    expect(ws).toHaveTextContent('问题已建模，正在合成硬件高效 Ansatz…');
    const toolLines = screen.getAllByTestId(/^subagent-tool-/);
    expect(toolLines.length).toBe(2);
    expect(toolLines[0].textContent).toContain('query_hardware');
    expect(toolLines[1].textContent).toContain('emit_artifact');
  });

  it('文本增量随 rerender 追加；aria-expanded 反映展开态', () => {
    const { rerender } = render(<SubagentWorkspace activity={RUNNING} />);
    const ws = screen.getByTestId('subagent-workspace-algorithm-designer');
    expect(ws.getAttribute('aria-expanded')).toBe('true');
    rerender(
      <SubagentWorkspace
        activity={{ ...RUNNING, text: RUNNING.text + '追加的增量。' }}
      />,
    );
    expect(ws).toHaveTextContent('追加的增量。');
  });

  it('dispatch_completed → 自动折叠为摘要行；点击可展开回看全程', () => {
    const { rerender } = render(<SubagentWorkspace activity={RUNNING} />);
    // 运行中 → 完成：自动折叠
    rerender(<SubagentWorkspace activity={DONE} />);
    const ws = screen.getByTestId('subagent-workspace-algorithm-designer');
    expect(ws.getAttribute('data-running')).toBe('false');
    expect(ws.getAttribute('aria-expanded')).toBe('false');
    const chars = Array.from(DONE.text).length;
    expect(ws).toHaveTextContent(`专家已完成 · 输出 ${chars} 字 · 工具 1 次`);
    // 折叠态不显示正文
    expect(screen.queryByText(/合成完成/)).toBeNull();
    // 点击头部 → 展开回看
    fireEvent.click(screen.getByTestId('subagent-toggle-algorithm-designer'));
    expect(ws.getAttribute('aria-expanded')).toBe('true');
    expect(ws).toHaveTextContent('合成完成，线路 6 个门。');
    expect(screen.getAllByTestId(/^subagent-tool-/).length).toBe(1);
  });

  it('空 text/tools 运行中不崩溃（仅头部）；agentName 缺省回退 agentId', () => {
    render(
      <SubagentWorkspace
        activity={{ agentId: 'calibration', phase: 'dispatch_started', text: '', tools: [] }}
      />,
    );
    const ws = screen.getByTestId('subagent-workspace-calibration');
    expect(ws.getAttribute('data-running')).toBe('true');
    expect(ws).toHaveTextContent('calibration');
    expect(screen.queryAllByTestId(/^subagent-tool-/)).toHaveLength(0);
  });
});
