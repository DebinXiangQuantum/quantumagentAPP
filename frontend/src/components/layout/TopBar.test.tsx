/**
 * TopBar.test.tsx —— v1.2/v1.3 顶栏改造测试（design.md §5）。
 *
 * 覆盖：
 *  1. v1.3 迁出：模型/思考选择器不在顶栏（移入 composer，见 MessageInput.test）；
 *  2. v1.2 常驻外观控件：主题三档分段图标（aria-pressed 即时切换 <html
 *     data-theme>）+ 语言下拉（三选即时生效）；
 *  3. 租户徽标含角色：admin 显示「管理员」徽标；user 不显示；
 *  4. SSE 连接灯与产品名保留。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TopBar } from './TopBar';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';

const TENANT_ADMIN = {
  id: 'demo',
  name: 'Demo 租户',
  enabled: true,
  role: 'admin' as const,
  usage: { active_tasks: 0, messages_today: 0 },
  quota: { max_concurrent_tasks: 2, max_messages_per_day: 1000 },
};

describe('TopBar（v1.2 外观控件 + 租户角色；v1.3 移出模型/思考）', () => {
  beforeEach(() => {
    useUiStore.getState().resetForTest();
    useAppStore.getState().resetForTest();
    useAppStore.setState({
      tenant: TENANT_ADMIN,
      modelChannels: [
        { ref: 'glm-5.3', provider: 'openai', model: 'glm-5.3', has_api_key: true, default_thinking: 'max' },
      ],
      currentModelRef: 'glm-5.3',
      currentThinkingLevel: 'max',
    });
  });

  it('模型/思考选择器已从顶栏移除（迁入 composer 工具条）', () => {
    render(<TopBar />);
    expect(screen.queryByTestId('topbar-model')).toBeNull();
    expect(screen.queryByTestId('topbar-thinking')).toBeNull();
    expect(screen.queryByTestId('composer-model')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /当前模型/ })).toBeNull();
  });

  it('外观控件：主题三档分段图标即时切换 + 语言下拉三选', () => {
    render(<TopBar />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => {
      fireEvent.click(screen.getByTestId('topbar-theme-light'));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByTestId('topbar-theme-light')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('topbar-theme-dark')).toHaveAttribute('aria-pressed', 'false');

    const lang = screen.getByTestId('topbar-language') as HTMLSelectElement;
    expect(Array.from(lang.options).map((o) => o.value)).toEqual(['zh', 'en', 'ja']);
    act(() => {
      fireEvent.change(lang, { target: { value: 'en' } });
    });
    expect(useUiStore.getState().language).toBe('en');
    expect(localStorage.getItem('qap.language')).toBe('en');
  });

  it('租户徽标：admin 显示「管理员」徽标；user 不显示', () => {
    const { rerender } = render(<TopBar />);
    expect(screen.getByTestId('tenant-badge').textContent).toContain('demo');
    expect(screen.getByTestId('tenant-role-badge').textContent).toBe('管理员');

    act(() => {
      useAppStore.setState({ tenant: { ...TENANT_ADMIN, role: 'user' } });
    });
    rerender(<TopBar />);
    expect(screen.queryByTestId('tenant-role-badge')).toBeNull();
    // 角色未知（旧后端缺字段）→ 按 user 降级，不显示徽标
    act(() => {
      useAppStore.setState({ tenant: { ...TENANT_ADMIN, role: undefined } });
    });
    rerender(<TopBar />);
    expect(screen.queryByTestId('tenant-role-badge')).toBeNull();
  });

  it('产品名与 SSE 连接灯保留', () => {
    render(<TopBar />);
    expect(screen.getByText('QuantumAgent · 异构量子智能体平台')).toBeInTheDocument();
    expect(screen.getByTestId('conn-light')).toBeInTheDocument();
  });
});
