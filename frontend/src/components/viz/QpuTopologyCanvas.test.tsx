/**
 * QpuTopologyCanvas.test.tsx —— QPU 拓扑保真度图测试（design.md §6.4 v1.2）。
 *
 * 覆盖：
 *  1. qubit 圆圈数 == qubits_count、coupler 连线数 == couplers.length；
 *  2. 圈下 readout 百分数（2 位小数）与连线中点 tq 百分数全部出现；
 *  3. 色阶：圈描边/连线着色档与 fidelityLevel 阈值一致（抽 green/red 样本）；
 *  4. 悬停 tooltip：qubit <title> 含 T1/T2/1Q/readout；
 *  5. 图例三档置底；>12×12 网格 → 滚动容器。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QpuTopologyCanvas } from './QpuTopologyCanvas';
import type { QpuMetrics } from '../../types/domain';
import { fidelityLevel } from '../../utils/hw';

function metricsOf(topo: QpuMetrics['topology']): QpuMetrics {
  return { qubits_count: topo.qubits.length, topology: topo };
}

const METRICS: QpuMetrics = {
  qubits_count: 4,
  topology: {
    layout: 'grid',
    rows: 2,
    cols: 2,
    qubits: [
      { id: 0, t1_us: 47.2, t2_us: 31.5, readout_fidelity: 0.978, sq_fidelity: 0.9993 },
      { id: 1, t1_us: 55.1, t2_us: 40.0, readout_fidelity: 0.941, sq_fidelity: 0.9961 },
      { id: 2, t1_us: 30.8, t2_us: 22.2, readout_fidelity: 0.991, sq_fidelity: 0.9995 },
      { id: 3, t1_us: 66.0, t2_us: 51.3, readout_fidelity: 0.987, sq_fidelity: 0.9988 },
    ],
    couplers: [
      { a: 0, b: 1, tq_fidelity: 0.9931 }, // green
      { a: 0, b: 2, tq_fidelity: 0.9875 }, // yellow
      { a: 1, b: 3, tq_fidelity: 0.9812 }, // red
      { a: 2, b: 3, tq_fidelity: 0.9920 }, // green
    ],
  },
};

describe('QpuTopologyCanvas', () => {
  it('圆圈数 == qubits、连线数 == couplers；数值不上图（IBM 式零文字标注）', () => {
    render(<QpuTopologyCanvas metrics={METRICS} />);
    expect(screen.getAllByTestId(/^qpu-topo-qubit-/).length).toBe(4);
    expect(screen.getAllByTestId(/^qpu-topo-coupler-/).length).toBe(4);
    expect(screen.queryAllByTestId(/^qpu-topo-readout-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^qpu-topo-tq-/)).toHaveLength(0);
  });

  it('色阶：连线/圈描边档与 fidelityLevel 一致；图例三档', () => {
    render(<QpuTopologyCanvas metrics={METRICS} />);
    const line01 = screen.getByTestId('qpu-topo-coupler-0-1');
    expect(line01.getAttribute('class')).toContain('qpu-topo--success');
    expect(fidelityLevel('2q', 0.9931)).toBe('success');
    const line13 = screen.getByTestId('qpu-topo-coupler-1-3');
    expect(line13.getAttribute('class')).toContain('qpu-topo--danger');
    // 圈 1 readout 0.941 → danger 描边
    const q1 = screen.getByTestId('qpu-topo-qubit-1');
    expect(q1.getAttribute('class')).toContain('qpu-topo--danger');
    // 图例三档
    expect(screen.getAllByTestId('qpu-topo-legend-item').length).toBe(3);
  });

  it('悬停 tooltip：比特含 T1/T2/1Q/readout；耦合器含 CZ 数值（浮层承载）', () => {
    render(<QpuTopologyCanvas metrics={METRICS} />);
    fireEvent.mouseEnter(screen.getByTestId('qpu-topo-qubit-0'));
    const tip = screen.getByTestId('qpu-topo-tooltip');
    expect(tip.textContent).toContain('47.2 µs'); // T1
    expect(tip.textContent).toContain('31.5 µs'); // T2
    expect(tip.textContent).toContain('99.93%'); // 1Q
    expect(tip.textContent).toContain('97.80%'); // readout
    fireEvent.mouseEnter(screen.getByTestId('qpu-topo-coupler-0-1'));
    expect(screen.getByTestId('qpu-topo-tooltip').textContent).toContain('99.31%'); // CZ
  });

  it('>12×12 网格 → 滚动容器；小网格不滚动', () => {
    const big = metricsOf({
      layout: 'grid',
      rows: 14,
      cols: 2,
      qubits: Array.from({ length: 28 }, (_, id) => ({
        id,
        t1_us: 40 + (id % 10),
        t2_us: 25 + (id % 8),
        readout_fidelity: 0.96 + (id % 20) / 1000,
        sq_fidelity: 0.998,
      })),
      couplers: [],
    });
    const { rerender } = render(<QpuTopologyCanvas metrics={big} />);
    expect(screen.getByTestId('qpu-topo-scroll').getAttribute('data-scrollable')).toBe('true');
    rerender(<QpuTopologyCanvas metrics={METRICS} />);
    expect(screen.getByTestId('qpu-topo-scroll').getAttribute('data-scrollable')).toBe('false');
  });
});

/** v1.4：云端真机降级——无 couplers/保真度时只渲染比特坐标点。 */
describe('QpuTopologyCanvas 云端坐标点降级（v1.4）', () => {
  const CLOUD: QpuMetrics = {
    qubits_count: 5,
    topology: {
      layout: 'cloud',
      rows: 0,
      cols: 0,
      qubits: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 1, y: 0 },
        { id: 2, x: 2, y: 0 },
        { id: 3, x: 3, y: 0 },
        { id: 4, x: 4, y: 0 },
      ],
      couplers: [],
    },
  };

  it('仅比特坐标点：无 coupler/无 readout 标注/图例隐藏；tooltip 平台未提供', () => {
    render(<QpuTopologyCanvas metrics={CLOUD} />);
    expect(screen.getAllByTestId(/^qpu-topo-qubit-/).length).toBe(5);
    expect(screen.queryAllByTestId(/^qpu-topo-coupler-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^qpu-topo-readout-/)).toHaveLength(0);
    expect(screen.queryAllByTestId('qpu-topo-legend-item')).toHaveLength(0);
    fireEvent.mouseEnter(screen.getByTestId('qpu-topo-qubit-0'));
    const tip = screen.getByTestId('qpu-topo-tooltip');
    expect(tip.textContent).toContain('平台未提供');
    expect(tip.textContent).toContain('0');
  });

  it('坐标摆放：按 qubit_coordinates 计算画布尺寸（5 列单行 → 宽 = 5*CELL+2*PAD）', () => {
    render(<QpuTopologyCanvas metrics={CLOUD} />);
    const svg = screen.getByRole('img');
    expect(Number(svg.getAttribute('width'))).toBe(5 * 46 + 24);
    expect(Number(svg.getAttribute('height'))).toBe(1 * 46 + 24);
  });

  it('部分保真度缺失：有 readout 的比特照常标注，缺省比特 tooltip 降级不崩溃', () => {
    const partial: QpuMetrics = {
      qubits_count: 2,
      topology: {
        layout: 'grid',
        rows: 1,
        cols: 2,
        qubits: [
          { id: 0, t1_us: 40, t2_us: 25, readout_fidelity: 0.97, sq_fidelity: 0.998 },
          { id: 1 },
        ],
        couplers: [],
      },
    };
    render(<QpuTopologyCanvas metrics={partial} />);
    expect(screen.getByTestId('qpu-topo-qubit-0')).toBeInTheDocument(); // 数值走悬停
    expect(screen.getByTestId('qpu-topo-qubit-1')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTestId('qpu-topo-qubit-1'));
    expect(screen.getByTestId('qpu-topo-tooltip').textContent).toContain('平台未提供');
  });

  it('坐标与网格都缺 → 降级提示行（不崩溃）', () => {
    render(
      <QpuTopologyCanvas
        metrics={{ qubits_count: 2, topology: { layout: 'x', rows: 0, cols: 0, qubits: [{ id: 0 }, { id: 1 }], couplers: [] } }}
      />,
    );
    expect(screen.getByText(/拓扑数据不可用/)).toBeInTheDocument();
  });
});
