/**
 * HardwareTopology.test.tsx —— 硬件拓扑视图测试（design.md §6.4）。
 *
 * 覆盖：
 *  1. fixture → 按 kind 分组的卡片（QPU/GPU/CPU 分组标题与数量）；
 *  2. 型号（等宽）、容量点（已占用实心）、利用率迷你条与数值；
 *  3. allocation 徽标文案 "algorithm-designer · t-2/s-4"；
 *  4. offline 节点降饱和斜纹类；
 *  5. 点击卡片 → Drawer：节点全量信息 + 该节点历史任务；
 *  6. 空数据 → 空态文案。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HardwareTopology } from './HardwareTopology';
import { HARDWARE_NODES, TASKS } from '../../api/mock/fixtures';

describe('HardwareTopology', () => {
  it('按 kind 分组渲染卡片与数量', () => {
    render(
      <HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />,
    );
    expect(screen.getByText('QPU')).toBeInTheDocument();
    expect(screen.getByText('GPU')).toBeInTheDocument();
    expect(screen.getByText('CPU')).toBeInTheDocument();
    // 5 节点：1 qpu + 3 gpu + 1 cpu
    expect(screen.getAllByTestId(/^hw-card-/).length).toBe(5);
  });

  it('型号/容量点/利用率/allocation 徽标渲染', () => {
    render(
      <HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />,
    );
    expect(screen.getAllByText('NVIDIA A800 80GB').length).toBe(2); // a800-0/a800-1
    // gpu-a800-0：capacity 1、1 个活动租约 → 1 实心 + 0 空心
    const card = screen.getByTestId('hw-card-gpu-a800-0');
    expect(
      card.querySelectorAll('.hw-card__dot--leased').length,
    ).toBe(1);
    expect(card.querySelectorAll('.hw-card__dot--free').length).toBe(0);
    expect(screen.getByText(/algorithm-designer · t-2\/s-4/)).toBeInTheDocument();
    expect(card.getAttribute('data-utilization')).toBe('0.86');
  });

  it('offline 节点带降饱和斜纹类', () => {
    render(
      <HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />,
    );
    expect(screen.getByTestId('hw-card-gpu-v100-0')).toHaveClass(
      'hw-card--offline',
    );
  });

  it('点击卡片 → Drawer 全量信息与该节点历史任务', () => {
    render(
      <HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />,
    );
    fireEvent.click(screen.getByTestId('hw-card-cpu-node-0'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveTextContent('cpu-node-0');
    expect(drawer).toHaveTextContent('EPYC 64C / 256GB');
    // 历史任务：cpu-node-0 上执行过 t-1 的 s-0 / s-2
    expect(drawer).toHaveTextContent('分子积分计算');
    expect(drawer).toHaveTextContent('结果后处理');
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('空数据渲染空态文案', () => {
    render(<HardwareTopology nodes={[]} tasks={[]} history={{}} />);
    expect(screen.getByText(/暂无硬件数据/)).toBeInTheDocument();
  });
});
