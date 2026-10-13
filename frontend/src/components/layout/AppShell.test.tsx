/**
 * AppShell.test.tsx —— 三栏布局骨架测试（design.md §5）。
 *
 * 覆盖：
 *  1. 顶栏渲染产品名「QuantumAgent · 异构量子智能体平台」；
 *  2. 侧栏 / 对话区 / 检查器三栏挂载，检查器含两个 Tab；
 *  3. 侧栏与检查器可折叠（按钮切换 data-collapsed 状态）；
 *  4. 折叠状态由 zustand store 持有，跨组件一致。
 *
 * 说明：交互用 fireEvent（白名单内 @testing-library/react 自带），
 * 不引入 @testing-library/user-event。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';
import { useUiStore } from '../../store/uiStore';

describe('AppShell 三栏布局', () => {
  it('渲染顶栏产品名与三个功能区', () => {
    render(<AppShell />);
    expect(
      screen.getByText('QuantumAgent · 异构量子智能体平台'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-panel')).toBeInTheDocument();
  });

  it('检查器包含「硬件拓扑」「任务 DAG」两个 Tab', () => {
    render(<AppShell />);
    expect(screen.getByRole('tab', { name: '硬件拓扑' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '任务 DAG' })).toBeInTheDocument();
  });

  it('侧栏可通过顶栏按钮折叠/展开', () => {
    render(<AppShell />);
    const sidebar = screen.getByTestId('session-sidebar');
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    fireEvent.click(screen.getByTestId('toggle-sidebar'));
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    fireEvent.click(screen.getByTestId('toggle-sidebar'));
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  });

  it('检查器可通过按钮折叠，且状态写入全局 store', () => {
    render(<AppShell />);
    expect(useUiStore.getState().inspectorOpen).toBe(true);
    fireEvent.click(screen.getByTestId('toggle-inspector'));
    expect(useUiStore.getState().inspectorOpen).toBe(false);
    expect(screen.getByTestId('inspector-panel')).toHaveAttribute(
      'data-collapsed',
      'true',
    );
  });
});
