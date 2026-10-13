/**
 * DagView.test.tsx —— 任务 DAG 视图测试（design.md §6.3）。
 *
 * 覆盖：
 *  1. 每个 Step 渲染一个节点（等宽 id + kind 色类 + 状态徽标）；
 *  2. 依赖边 == sum(depends_on)，箭头 path 存在；
 *  3. 运行中节点带呼吸光晕类（reduced-motion 由 CSS 全局降级）；
 *  4. 点击节点 → Drawer 显示 node_id / 起止时间 / detail / error；
 *  5. 空任务/畸形任务 → 空态文案不崩溃。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DagView } from './DagView';
import type { Task } from '../../types/domain';

const TASK: Task = {
  id: 't-1',
  conversation_id: 'c-1',
  tenant_id: 'demo',
  name: 'VQE 全流程',
  status: 'running',
  created_at: '2026-10-13T07:41:04Z',
  steps: [
    {
      id: 's-0',
      name: '分子积分计算',
      kind: 'classical',
      status: 'succeeded',
      node_id: 'cpu-node-0',
      depends_on: [],
      started_at: '2026-10-13T07:41:05Z',
      finished_at: '2026-10-13T07:41:12Z',
      detail: 'STO-3G 积分',
      error: null,
    },
    {
      id: 's-1',
      name: 'VQE 线路执行',
      kind: 'quantum',
      status: 'running',
      node_id: 'qpu-quanta-20q',
      depends_on: ['s-0'],
      started_at: '2026-10-13T07:41:12Z',
      finished_at: null,
      detail: '参数采样中',
      error: null,
    },
    {
      id: 's-2',
      name: '结果后处理',
      kind: 'classical',
      status: 'failed',
      node_id: null,
      depends_on: ['s-1'],
      started_at: null,
      finished_at: null,
      detail: '',
      error: '步骤超时（60s）',
    },
  ],
};

describe('DagView', () => {
  it('每步一节点：等宽 id、kind 色类、状态徽标', () => {
    render(<DagView task={TASK} />);
    const n0 = screen.getByTestId('dag-node-s-0');
    expect(n0).toHaveClass('dag-node--classical');
    expect(screen.getByTestId('dag-node-s-1')).toHaveClass('dag-node--quantum');
    expect(screen.getByTestId('dag-node-s-1').textContent).toContain('s-1'); // 等宽 id 可见
    expect(screen.getByTestId('dag-node-s-1').textContent).toContain('运行中');
    expect(screen.getByTestId('dag-node-s-2').textContent).toContain('已失败');
  });

  it('依赖边 == sum(depends_on)，SVG path 存在', () => {
    render(<DagView task={TASK} />);
    const paths = document.querySelectorAll('[data-testid^="dag-edge-"]');
    expect(paths.length).toBe(2);
  });

  it('纵向流水线布局：链式 3 层 → SVG 高 3×64+2×24=240、宽 200（适配 360px 检查器）', () => {
    render(<DagView task={TASK} />);
    const svg = document.querySelector('svg.dag-view__edges') as SVGSVGElement | null;
    expect(svg).not.toBeNull();
    // 单节点/层的链：宽度收敛为单节点宽，高度按层堆叠（不再横向溢出面板）
    expect(svg!.getAttribute('width')).toBe('200');
    expect(svg!.getAttribute('height')).toBe('240');
    // 画布容器显式给出内容尺寸（绝对定位内容不再导致高度塌缩）
    const canvas = document.querySelector('.dag-view__canvas') as HTMLElement | null;
    expect(canvas).not.toBeNull();
    expect(canvas!.style.height).toBe('248px'); // 240 + 8px 余量
  });

  it('运行中节点带呼吸光晕类', () => {
    render(<DagView task={TASK} />);
    expect(screen.getByTestId('dag-node-s-1')).toHaveClass('dag-node--running');
  });

  it('点击节点 → Drawer 详情（node_id/时间/detail/error）', () => {
    render(<DagView task={TASK} />);
    fireEvent.click(screen.getByTestId('dag-node-s-2'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveTextContent('s-2');
    expect(drawer).toHaveTextContent('步骤超时');
    expect(drawer).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('空任务/畸形任务降级为空态，不崩溃', () => {
    render(
      <DagView
        task={{ ...TASK, steps: [] } as Task}
      />,
    );
    expect(screen.getByText(/暂无任务/)).toBeInTheDocument();
    render(<DagView task={null as unknown as Task} />);
    expect(screen.getAllByText(/暂无任务/).length).toBe(2);
  });
});
