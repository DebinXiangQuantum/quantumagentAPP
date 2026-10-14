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
import { render, screen } from '@testing-library/react';
import { QpuTopologyCanvas } from './QpuTopologyCanvas';
import type { QpuMetrics } from '../../types/domain';
import { fidelityLevel, formatFidelity } from '../../utils/hw';

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
  it('圆圈数 == qubits、连线数 == couplers；readout/tq 百分数标注齐全', () => {
    render(<QpuTopologyCanvas metrics={METRICS} />);
    expect(screen.getAllByTestId(/^qpu-topo-qubit-/).length).toBe(4);
    expect(screen.getAllByTestId(/^qpu-topo-coupler-/).length).toBe(4);
    for (const q of METRICS.topology.qubits) {
      expect(screen.getByTestId(`qpu-topo-readout-${q.id}`).textContent).toBe(
        formatFidelity(q.readout_fidelity),
      );
    }
    for (const c of METRICS.topology.couplers) {
      expect(screen.getByTestId(`qpu-topo-tq-${c.a}-${c.b}`).textContent).toBe(
        formatFidelity(c.tq_fidelity),
      );
    }
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

  it('悬停 tooltip：qubit title 含 T1/T2/1Q/readout 数值', () => {
    render(<QpuTopologyCanvas metrics={METRICS} />);
    const title = screen.getByTestId('qpu-topo-qubit-0').querySelector('title');
    expect(title?.textContent).toContain('47.2 µs');
    expect(title?.textContent).toContain('31.5 µs');
    expect(title?.textContent).toContain('99.93%'); // 1Q
    expect(title?.textContent).toContain('97.80%'); // readout
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
      qubits: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      couplers: [],
      qubit_coordinates: [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ],
    },
  };

  it('仅比特坐标点：无 coupler/无 readout 标注/图例隐藏；tooltip 平台未提供', () => {
    render(<QpuTopologyCanvas metrics={CLOUD} />);
    expect(screen.getAllByTestId(/^qpu-topo-qubit-/).length).toBe(5);
    expect(screen.queryAllByTestId(/^qpu-topo-coupler-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^qpu-topo-readout-/)).toHaveLength(0);
    expect(screen.queryAllByTestId('qpu-topo-legend-item')).toHaveLength(0);
    for (const q of CLOUD.topology.qubits) {
      const title = screen.getByTestId(`qpu-topo-qubit-${q.id}`).querySelector('title');
      expect(title?.textContent).toContain('平台未提供');
      expect(title?.textContent).toContain(String(q.id));
    }
  });

  it('坐标摆放：按 qubit_coordinates 计算画布尺寸（5 列单行 → 宽 = 5*CELL+2*PAD）', () => {
    render(<QpuTopologyCanvas metrics={CLOUD} />);
    const svg = screen.getByRole('img');
    expect(Number(svg.getAttribute('width'))).toBe(5 * 62 + 20);
    expect(Number(svg.getAttribute('height'))).toBe(1 * 62 + 20);
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
    expect(screen.getByTestId('qpu-topo-readout-0').textContent).toBe('97.00%');
    expect(screen.queryByTestId('qpu-topo-readout-1')).toBeNull();
    expect(
      screen.getByTestId('qpu-topo-qubit-1').querySelector('title')?.textContent,
    ).toContain('平台未提供');
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
