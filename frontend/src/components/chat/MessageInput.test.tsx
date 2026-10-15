/**
 * MessageInput.test.tsx —— v1.3 composer（输入区工具条）测试（design.md §5）。
 *
 * 覆盖：
 *  1. 工具条结构：左 ＋附件按钮、中部 模型▾/思考▾ 选择器（v1.2 从顶栏迁入）、
 *     右 发送按钮——输入区自身就是选择器宿主；
 *  2. 选择器行为：模型选项来自渠道池；切模型思考跟随 default_thinking
 *     （联动在 appStore，此处断言透传）；
 *  3. 键盘行为保留：Enter 发送 / Shift+Enter 换行 / 纯空白不发送（仅附件可发）；
 *  4. 发送中态：store.sending → 按钮禁用 + 文案"发送中…"；失败内联条
 *     （sendError + 重试按钮调 retrySend）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MessageInput } from './MessageInput';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { createFakeApi, type FakeApiClient } from '../../test/fakeApi';
import { setApi } from '../../api';
import type { ModelChannel } from '../../types/domain';

function channel(partial: Partial<ModelChannel> & { ref: string }): ModelChannel {
  return {
    provider: 'openai',
    model: partial.ref,
    base_url: '',
    api_key_env: '',
    has_api_key: true,
    default_thinking: 'high',
    timeout_seconds: 120,
    ...partial,
  };
}

const CHANNELS: ModelChannel[] = [
  channel({ ref: 'glm-5.3', model: 'glm-5.3', default_thinking: 'max' }),
  channel({ ref: 'glm-5.3-flash', model: 'glm-5.3-flash', default_thinking: 'low' }),
];

describe('MessageInput（v1.3 composer 工具条）', () => {
  let client: FakeApiClient;

  beforeEach(() => {
    client = createFakeApi();
    setApi(client);
    useUiStore.getState().resetForTest();
    useAppStore.getState().resetForTest();
    useAppStore.setState({
      modelChannels: CHANNELS,
      currentModelRef: 'glm-5.3',
      currentThinkingLevel: 'max',
      activeConversationId: 'c-1',
    });
  });

  it('工具条：左 ＋附件、中 模型/思考选择器（渠道池选项）、右 发送', () => {
    render(<MessageInput onSend={vi.fn()} />);
    expect(screen.getByTestId('composer-attach')).toBeInTheDocument();
    const model = screen.getByTestId('composer-model') as HTMLSelectElement;
    expect(model.value).toBe('glm-5.3');
    expect(Array.from(model.options).map((o) => o.value)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
    ]);
    const thinking = screen.getByTestId('composer-thinking') as HTMLSelectElement;
    expect(thinking.value).toBe('max');
    expect(Array.from(thinking.options).map((o) => o.textContent)).toEqual([
      '关闭',
      '低',
      '高',
      '最大',
    ]);
    expect(screen.getByTestId('composer-send')).toBeInTheDocument();
  });

  it('工具条选择器写回 store：切模型 → 思考跟随渠道 default_thinking', () => {
    render(<MessageInput onSend={vi.fn()} />);
    act(() => {
      fireEvent.change(screen.getByTestId('composer-model'), {
        target: { value: 'glm-5.3-flash' },
      });
    });
    expect(useAppStore.getState().currentModelRef).toBe('glm-5.3-flash');
    expect(useAppStore.getState().currentThinkingLevel).toBe('low');
    act(() => {
      fireEvent.change(screen.getByTestId('composer-thinking'), {
        target: { value: 'off' },
      });
    });
    expect(useAppStore.getState().currentThinkingLevel).toBe('off');
    expect(useAppStore.getState().thinkingTouched).toBe(true);
  });

  it('Enter 发送并清空；Shift+Enter 换行；纯空白不发送', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '你好' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('你好', []);
    expect(ta.value).toBe('');
    fireEvent.change(ta, { target: { value: '第二行' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('发送中态：sending → 按钮禁用 + "发送中…"；失败内联条可重试', async () => {
    render(<MessageInput onSend={vi.fn()} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '有内容' } });
    const send = screen.getByTestId('composer-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    act(() => {
      useAppStore.setState({ sending: true });
    });
    expect(send.disabled).toBe(true);
    expect(send.textContent).toBe('发送中…');

    act(() => {
      useAppStore.setState({ sending: false, sendError: '429: 超出配额' });
    });
    expect(screen.getByTestId('composer-error')).toHaveTextContent('429');
    // 替换 store action（zustand 动作住在 state 里，spyOn 快照无效）
    const retrySpy = vi.fn(async () => undefined);
    act(() => {
      useAppStore.setState({ retrySend: retrySpy });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('composer-retry'));
    });
    expect(retrySpy).toHaveBeenCalled();
  });
});

/** v1.4：所选渠道 provider=mock → 模型名旁「演示」徽标（防误用提示）。 */
;
