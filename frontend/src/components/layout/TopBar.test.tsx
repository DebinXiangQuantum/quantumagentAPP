/**
 * TopBar.test.tsx —— v1.1 顶栏改造测试（design.md §5）。
 *
 * 覆盖：
 *  1. Agent 选择器已移除（顶栏不再渲染 Agent select / 「Agent」标签）；
 *  2. 模型选择器：选项来自 admin models 渠道池（ref · model）；
 *  3. 思考程度选择器：off/low/high/max 四档（i18n 文案）；
 *  4. 联动：切模型 → 思考跟随新渠道 default_thinking；手动改思考后
 *     本会话内切模型保持手动值；
 *  5. 选择随消息发送：sendMessage POST body 含 model_ref / thinking_level。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TopBar } from './TopBar';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import type { ModelChannel } from '../../types/domain';

function channel(partial: Partial<ModelChannel> & { ref: string }): ModelChannel {
  return {
    provider: 'openai',
    model: partial.ref,
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_env: 'GLM_API_KEY',
    has_api_key: true,
    default_thinking: 'high',
    timeout_seconds: 120,
    ...partial,
  };
}

const CHANNELS: ModelChannel[] = [
  channel({ ref: 'glm-5.3', model: 'glm-5.3', default_thinking: 'max' }),
  channel({ ref: 'glm-5.3-flash', model: 'glm-5.3-flash', default_thinking: 'low' }),
  channel({ ref: 'mock', model: 'mock-llm', provider: 'mock', default_thinking: 'off' }),
];

describe('TopBar（v1.1 模型 + 思考选择器）', () => {
  beforeEach(() => {
    useUiStore.getState().resetForTest();
    useAppStore.getState().resetForTest();
    useAppStore.setState({ modelChannels: CHANNELS, currentModelRef: 'glm-5.3', currentThinkingLevel: 'max' });
  });

  it('Agent 选择器已移除；渲染模型选择器（渠道池选项）', () => {
    render(<TopBar />);
    expect(screen.queryByLabelText('当前 Agent')).toBeNull();
    // 模型选择器存在且选项来自渠道池
    const modelSelect = screen.getByTestId('topbar-model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('glm-5.3');
    expect(Array.from(modelSelect.options).map((o) => o.value)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'mock',
    ]);
    // 顶栏不再出现独立的 Agent 标签文本
    expect(screen.queryByText(/^Agent$/)).toBeNull();
  });

  it('思考程度选择器：off/low/high/max 四档（中文文案）', () => {
    render(<TopBar />);
    const thinking = screen.getByTestId('topbar-thinking') as HTMLSelectElement;
    expect(thinking.value).toBe('max');
    expect(Array.from(thinking.options).map((o) => o.textContent)).toEqual([
      '关闭',
      '低',
      '高',
      '最大',
    ]);
  });

  it('联动：切模型 → 思考跟随渠道 default_thinking；手动改过则本会话保持', () => {
    render(<TopBar />);
    const modelSelect = screen.getByTestId('topbar-model');
    const thinking = screen.getByTestId('topbar-thinking');

    // 未手动改思考：切到 flash 渠道 → 跟随其 default_thinking=low
    act(() => {
      fireEvent.change(modelSelect, { target: { value: 'glm-5.3-flash' } });
    });
    expect(useAppStore.getState().currentModelRef).toBe('glm-5.3-flash');
    expect((thinking as HTMLSelectElement).value).toBe('low');

    // 手动改思考 → thinkingTouched
    act(() => {
      fireEvent.change(thinking, { target: { value: 'max' } });
    });
    expect(useAppStore.getState().currentThinkingLevel).toBe('max');
    expect(useAppStore.getState().thinkingTouched).toBe(true);

    // 再切模型：手动值保持（不被渠道默认覆盖）
    act(() => {
      fireEvent.change(modelSelect, { target: { value: 'mock' } });
    });
    expect(useAppStore.getState().currentModelRef).toBe('mock');
    expect(useAppStore.getState().currentThinkingLevel).toBe('max');
  });

  it('选择随消息发送：POST body 含 model_ref / thinking_level', async () => {
    const { setApi } = await import('../../api');
    const { createMockClient } = await import('../../api/mock/engine');
    const apiSpy = vi.fn(async () => ({ message_id: 'm-x', run_id: 'r-x' }));
    setApi({ ...createMockClient(), sendMessage: apiSpy } as never);
    useAppStore.setState({
      activeConversationId: 'c-1',
      conversations: [
        {
          id: 'c-1',
          title: 'T',
          agent_id: 'orchestrator',
          tenant_id: 'demo',
          created_at: '2026-10-13T08:00:00Z',
        },
      ],
      messagesByCid: {},
      currentModelRef: 'glm-5.3-flash',
      currentThinkingLevel: 'high',
    });
    await useAppStore.getState().sendMessage('设计 VQE');
    expect(apiSpy).toHaveBeenCalledWith('c-1', '设计 VQE', {
      model_ref: 'glm-5.3-flash',
      thinking_level: 'high',
    });
  });
});
