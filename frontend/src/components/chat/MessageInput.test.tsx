/**
 * MessageInput.test.tsx —— 输入区键盘行为测试。
 *
 * 覆盖：
 *  1. Enter（无 Shift）发送并清空；
 *  2. Shift+Enter 换行不发送；
 *  3. 纯空白不发送；
 *  4. Agent 快捷切换写入 store。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageInput } from './MessageInput';
import { useAppStore } from '../../store/appStore';

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

  it('Agent 快捷切换写入 store.currentAgentId', () => {
    useAppStore.setState({
      agents: [
        {
          id: 'algorithm-designer',
          name: '算法',
          description: '',
          capabilities: [],
          model_ref: 'default',
          builtin: true,
        },
        {
          id: 'calibration',
          name: '校准',
          description: '',
          capabilities: [],
          model_ref: 'default',
          builtin: true,
        },
      ],
      currentAgentId: 'algorithm-designer',
    });
    render(<MessageInput onSend={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('快捷切换 Agent'), {
      target: { value: 'calibration' },
    });
    expect(useAppStore.getState().currentAgentId).toBe('calibration');
  });
});
