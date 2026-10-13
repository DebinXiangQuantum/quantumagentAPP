/**
 * CountsHistogram.test.tsx —— 测量计数直方图测试（design.md §6.2）。
 *
 * 覆盖：
 *  1. 归一化不变量：max(条高)/绘图高 == max(counts)/max_count
 *     （即最高条 data-height == 容器 data-plot-height）；
 *  2. 条形按计数降序排列，横轴比特串等宽展示；
 *  3. hover 显示计数与占比；
 *  4. 空数据/畸形数据降级（空态/错误提示，不崩溃）。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CountsHistogram } from './CountsHistogram';

const PAYLOAD = {
  shots: 1024,
  qubits: 2,
  counts: { '00': 498, '11': 512, '01': 8, '10': 6 },
};

describe('CountsHistogram', () => {
  it('归一化不变量：最高条高度 == 绘图高度', () => {
    render(<CountsHistogram payload={PAYLOAD} />);
    const plot = screen.getByTestId('counts-plot');
    const plotH = Number(plot.getAttribute('data-plot-height'));
    const bars = Array.from(
      document.querySelectorAll('[data-testid^="counts-bar-"]'),
    );
    const heights = bars.map((b) => Number(b.getAttribute('data-height')));
    const maxCount = Math.max(...Object.values(PAYLOAD.counts));
    const minCount = Math.min(...Object.values(PAYLOAD.counts));
    expect(Math.max(...heights)).toBe(plotH);
    // 最小条高度也应成比例（count/maxCount × plotH）
    expect(Math.min(...heights)).toBeCloseTo((minCount / maxCount) * plotH, 5);
  });

  it('按计数降序排列；比特串等宽标签齐全', () => {
    render(<CountsHistogram payload={PAYLOAD} />);
    const bars = Array.from(
      document.querySelectorAll('[data-testid^="counts-bar-"]'),
    );
    const counts = bars.map((b) => Number(b.getAttribute('data-count')));
    expect(counts).toEqual([512, 498, 8, 6]);
    for (const bitstring of ['00', '11', '01', '10']) {
      expect(screen.getByText(bitstring)).toBeInTheDocument();
    }
    expect(screen.getByText(/1024/)).toBeInTheDocument(); // 总 shots 副标题
  });

  it('hover 显示计数与占比', () => {
    render(<CountsHistogram payload={PAYLOAD} />);
    fireEvent.mouseEnter(screen.getByTestId('counts-bar-11'));
    const tip = screen.getByTestId('counts-tooltip');
    expect(tip).toHaveTextContent('11');
    expect(tip).toHaveTextContent('512');
    expect(tip).toHaveTextContent('50%');
  });

  it('空数据与畸形数据降级，不崩溃', () => {
    render(<CountsHistogram payload={{ shots: 0, qubits: 2, counts: {} }} />);
    expect(screen.getByText(/无测量数据/)).toBeInTheDocument();
    render(<CountsHistogram payload="garbage" />);
    expect(screen.getAllByText(/无法解析计数/).length).toBeGreaterThan(0);
    render(
      <CountsHistogram
        payload={{ shots: 10, qubits: 2, counts: { '00': -3 } }}
      />,
    );
    expect(screen.getAllByText(/无法解析计数/).length).toBeGreaterThan(0);
  });
});
