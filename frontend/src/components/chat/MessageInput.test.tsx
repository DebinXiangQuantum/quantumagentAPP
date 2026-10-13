/**
 * MessageInput.test.tsx —— 输入区键盘行为测试。
 *
 * 覆盖：
 *  1. Enter（无 Shift）发送并清空；
 *  2. Shift+Enter 换行不发送；
 *  3. 纯空白不发送；
 *  4. v1.1：输入区不再渲染 Agent 快捷切换（编排 Agent 自动调度，
 *     模型/思考选择器移至顶栏，见 TopBar.test.tsx）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageInput } from './MessageInput';

describe('MessageInput', () => {
  it('Enter 发送并清空输入', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '你好' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('你好');
    expect(ta.value).toBe('');
  });

  it('Shift+Enter 换行不发送', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '第一行' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('纯空白内容不发送', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '   \n  ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('v1.1：输入区无 Agent 选择器（无 select，无 Agent 标签）', () => {
    render(<MessageInput onSend={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/^Agent$/)).toBeNull();
  });
});
