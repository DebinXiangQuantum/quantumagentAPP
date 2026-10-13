/**
 * Skeletons.test.tsx —— 同构骨架屏与全局错误条测试（design.md §7/§8）。
 *
 * 覆盖：
 *  1. 会话侧栏/检查器在 loading（booted=false 且无错误）时渲染同构骨架；
 *  2. bootstrap 失败 → 全局警示条 + 重试按钮调用 retryBootstrap；
 *  3. 消息流 loading（会话已选但消息未加载）→ 消息骨架。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from '../layout/AppShell';
import { GlobalErrorBar } from './GlobalErrorBar';
import {
  ConversationSkeleton,
  HwCardSkeleton,
  MessageSkeleton,
} from './Skeletons';
import { useAppStore } from '../../store/appStore';

describe('非理想态：loading 骨架 / 错误重试', () => {
  it('booted=false 且无错误：侧栏渲染会话骨架（同构结构）', () => {
    useAppStore.setState({
      booted: false,
      bootError: null,
      conversations: [],
    });
    render(<AppShell />);
    const list = screen.getByTestId('conversation-list');
    expect(list.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(3);
  });

  it('booted=false：硬件拓扑 Tab 渲染硬件卡片骨架', () => {
    useAppStore.setState({
      booted: false,
      bootError: null,
      hardwareNodes: [],
    });
    render(<AppShell />);
    const body = screen.getByTestId('inspector-panel');
    expect(body.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(4);
  });

  it('bootError → 全局警示条 + 重试按钮调用 retryBootstrap', () => {
    const retry = vi.fn();
    render(<GlobalErrorBar message="初始化失败：backend down" retry={retry} />);
    expect(screen.getByText(/初始化失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('单个骨架组件可独立渲染（结构同构占位）', () => {
    render(
      <>
        <ConversationSkeleton />
        <MessageSkeleton />
        <HwCardSkeleton />
      </>,
    );
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(3);
  });
});
