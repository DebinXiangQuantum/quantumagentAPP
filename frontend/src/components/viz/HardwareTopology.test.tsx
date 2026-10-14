/**
 * HardwareTopology.test.tsx —— 硬件拓扑视图测试（design.md §6.4，v1.2 升级）。
 *
 * 覆盖：
 *  1. fixture → 按 kind 分组的卡片（10 QPU + 3 GPU + 1 CPU）；
 *  2. v1.2 QPU 分组头 `QPU · 在线 6/10`（离线计入总数）；
 *  3. QPU 卡副行 `NNQ · 2Q 保真度中位 NN.N%`（等宽）；离线卡降饱和类 + 徽标；
 *  4. CPU 卡 CPU% + 内存双迷你条；GPU 卡 VRAM 迷你条（usageLevel 着色）；
 *  5. allocation 徽标 / 容量点 / 利用率（既有行为回归）；
 *  6. 点击 QPU 卡 → Drawer 内嵌拓扑保真度图 + 摘要行；
 *  7. 空数据 → 空态文案。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HardwareTopology } from './HardwareTopology';
import { HARDWARE_NODES, TASKS } from '../../api/mock/fixtures';
import { formatFidelity, medianTqFidelity } from '../../utils/hw';
import type { QpuMetrics } from '../../types/domain';

const qpu20 = HARDWARE_NODES.find((n) => n.id === 'qpu-quanta-20q')!;
const qpuMedian = medianTqFidelity(
  (qpu20.metrics as QpuMetrics).topology.couplers,
)!;

describe('HardwareTopology（v1.2 性能监控与 QPU 拓扑）', () => {
  it('按 kind 分组渲染卡片（10 QPU + 3 GPU + 1 CPU = 14）', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    expect(screen.getByTestId('hw-group-header-qpu').textContent).toContain('QPU');
    expect(screen.getByTestId('hw-group-header-gpu').textContent).toContain('GPU');
    expect(screen.getByTestId('hw-group-header-cpu').textContent).toContain('CPU');
    expect(screen.getAllByTestId(/^hw-card-/).length).toBe(14);
  });

  it('QPU 分组头：`QPU · 在线 6/10`（离线计入总数）', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    const header = screen.getByTestId('hw-group-header-qpu');
    expect(header.textContent).toContain('QPU');
    expect(header.textContent).toContain('在线 6/10');
  });

  it('QPU 卡副行：`20Q · 2Q 保真度中位 NN.NN%`（等宽）；离线卡降饱和 + 离线徽标', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    const card = screen.getByTestId('hw-card-qpu-quanta-20q');
    const subline = card.querySelector('.hw-card__qpu-subline');
    expect(subline).not.toBeNull();
    expect(subline).toHaveClass('mono');
    expect(subline!.textContent).toBe(
      `20Q · 2Q 保真度中位 ${formatFidelity(qpuMedian)}`,
    );
    const offlineCard = screen.getByTestId('hw-card-qpu-phoenix-16q');
    expect(offlineCard).toHaveClass('hw-card--offline');
    expect(offlineCard.textContent).toContain('离线');
  });

  it('CPU 卡：CPU 使用率 + 内存双迷你条；GPU 卡：VRAM 迷你条（usageLevel 着色）', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    const cpu = screen.getByTestId('hw-card-cpu-node-0');
    expect(cpu.querySelectorAll('.hw-card__mini').length).toBe(2);
    expect(cpu.textContent).toContain('CPU');
    expect(cpu.textContent).toContain('98.4/256.0 GB');

    const gpu = screen.getByTestId('hw-card-gpu-a800-0');
    const vram = gpu.querySelector('.hw-card__mini--vram');
    expect(vram).not.toBeNull();
    expect(vram!.textContent).toContain('12.6/80.0 GB');
    // 12.6/80 = 0.1575 → normal 档
    expect(vram!.querySelector('.hw-card__mini-fill')).toHaveClass('hw-mini-fill--normal');
    // a800-1: 61.3/80 = 0.766 → normal；压力演示不越 0.8
    const gpu1 = screen.getByTestId('hw-card-gpu-a800-1');
    expect(gpu1.querySelector('.hw-card__mini--vram')).not.toBeNull();
  });

  it('型号/容量点/利用率/allocation 徽标（既有回归）', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    expect(screen.getAllByText('NVIDIA A800 80GB').length).toBe(2);
    const card = screen.getByTestId('hw-card-gpu-a800-0');
    expect(card.querySelectorAll('.hw-card__dot--leased').length).toBe(1);
    expect(screen.getByText(/algorithm-designer · t-2\/s-4/)).toBeInTheDocument();
    expect(card.getAttribute('data-utilization')).toBe('0.86');
  });

  it('点击 QPU 卡 → Drawer 内嵌拓扑保真度图 + 摘要行', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    fireEvent.click(screen.getByTestId('hw-card-qpu-quanta-20q'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveTextContent('qpu-quanta-20q');
    // 摘要 "20Q · 2Q 保真度中位 NN.NN%"
    expect(screen.getByTestId('hw-drawer-topo-summary').textContent).toBe(
      `20Q · 2Q 保真度中位 ${formatFidelity(qpuMedian)}`,
    );
    // 内嵌 canvas：圆圈数 == qubits_count
    expect(screen.getAllByTestId(/^qpu-topo-qubit-/).length).toBe(20);
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('点击 CPU 卡 → Drawer 含核数/内存数值；空数据渲染空态文案', () => {
    render(<HardwareTopology nodes={HARDWARE_NODES} tasks={TASKS} history={{}} />);
    fireEvent.click(screen.getByTestId('hw-card-cpu-node-0'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveTextContent('核数');
    expect(drawer).toHaveTextContent('98.4 / 256.0 GB'); // 内存 used / total
    fireEvent.click(screen.getByTestId('drawer-close'));

    render(<HardwareTopology nodes={[]} tasks={[]} history={{}} />);
    expect(screen.getByText(/暂无硬件数据/)).toBeInTheDocument();
  });
});
