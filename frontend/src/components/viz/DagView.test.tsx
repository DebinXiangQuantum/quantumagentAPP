/**
 * DagView.test.tsx —— 任务 DAG 视图测试（design.md §6.3 v1.3 升级）。
 *
 * 覆盖：
 *  1. 结构模式（既有）：每 Step 一节点（等宽 id + kind 色 + 状态徽标 +
 *     依赖边 == sum(depends_on) + 呼吸光晕）；几何 v1.3：节点 232×92
 *     （增实测行）；点击节点 → Drawer；
 *  2. 实测标注：节点内 `时长 413ms` / `内存 18.3MB`（等宽）；null → "—"；
 *  3. 「结构 / 时间线」二段切换：时间线 = 水平 Gantt——条形几何不变量
 *     （left/width 与 duration/total 归一一致）、0/25/50/75/100% 刻度、
 *     悬停 title 含起止与时长、未开始步骤无条形；
 *  4. 嵌套下钻：subtask_id 非空节点显示 ⊕；点击加载子 DAG（loadTask）；
 *     面包屑逐级返回；子图同样支持二段切换；
 *  5. Drawer 补实测字段与子任务链接；
 *  6. 空任务/畸形任务 → 空态文案不崩溃。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      finished_at: '2026-10-13T07:41:12.4Z',
      duration_ms: 7412.7,
      peak_memory_mb: 18.3,
      subtask_id: null,
      detail: 'STO-3G 积分',
      error: null,
    },
    {
      id: 's-1',
      name: 'VQE 线路执行',
      kind: 'quantum',
      status: 'succeeded',
      node_id: 'qpu-quanta-20q',
      depends_on: ['s-0'],
      started_at: '2026-10-13T07:41:12.4Z',
      finished_at: '2026-10-13T07:41:16Z',
      duration_ms: 3600,
      peak_memory_mb: null,
      subtask_id: 't-sub',
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
      duration_ms: null,
      peak_memory_mb: null,
      subtask_id: null,
      detail: '',
      error: '步骤超时（60s）',
    },
  ],
};

const SUBTASK: Task = {
  ...TASK,
  id: 't-sub',
  name: '参数优化子流程',
  steps: [
    {
      id: 'ss-0',
      name: '梯度估计',
      kind: 'quantum',
      status: 'succeeded',
      node_id: 'qpu-quanta-20q',
      depends_on: [],
      started_at: '2026-10-13T07:41:12.4Z',
      finished_at: '2026-10-13T07:41:14Z',
      duration_ms: 1600,
      peak_memory_mb: 12.0,
      subtask_id: null,
      detail: '',
      error: null,
    },
  ],
};

describe('DagView（结构模式，v1.3 几何）', () => {
  it('每步一节点：等宽 id、kind 色类、状态徽标；节点 232×92', () => {
    render(<DagView task={TASK} />);
    const n0 = screen.getByTestId('dag-node-s-0');
    expect(n0).toHaveClass('dag-node--classical');
    expect(screen.getByTestId('dag-node-s-1')).toHaveClass('dag-node--quantum');
    expect(screen.getByTestId('dag-node-s-1').textContent).toContain('s-1');
    expect(screen.getByTestId('dag-node-s-0').style.width).toBe('232px');
    expect(screen.getByTestId('dag-node-s-0').style.height).toBe('92px');
    expect(screen.getByTestId('dag-node-s-1')).not.toHaveClass('dag-node--running');
  });

  it('依赖边 == sum(depends_on)；纵向画布显式内容尺寸', () => {
    render(<DagView task={TASK} />);
    expect(document.querySelectorAll('[data-testid^="dag-edge-"]').length).toBe(2);
    const svg = document.querySelector('svg.dag-view__edges') as SVGSVGElement;
    // 3 层链式：高 3×92+2×24=324；宽 232
    expect(svg.getAttribute('width')).toBe('232');
    expect(svg.getAttribute('height')).toBe('324');
  });

  it('实测标注：时长/内存（等宽行）；null → "—"', () => {
    render(<DagView task={TASK} />);
    const n0 = screen.getByTestId('dag-node-s-0');
    expect(n0.textContent).toContain('时长 7.4s');
    expect(n0.textContent).toContain('内存 18.3MB');
    const n1 = screen.getByTestId('dag-node-s-1');
    expect(n1.textContent).toContain('时长 3.6s');
    expect(n1.textContent).toContain('内存 —');
    expect(n0.querySelector('.dag-node__measured')).toHaveClass('mono');
  });

  it('点击节点 → Drawer：基本字段 + 实测时长/峰值内存 + 子任务链接', () => {
    render(<DagView task={TASK} />);
    fireEvent.click(screen.getByTestId('dag-node-s-1'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveTextContent('s-1');
    expect(drawer).toHaveTextContent('实测时长');
    expect(drawer).toHaveTextContent('3.6s');
    expect(drawer).toHaveTextContent('峰值内存');
    expect(drawer).toHaveTextContent('—');
    expect(screen.getByTestId('dag-detail-subtask')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('空任务/畸形任务降级为空态，不崩溃', () => {
    render(<DagView task={{ ...TASK, steps: [] } as Task} />);
    expect(screen.getByText(/暂无任务/)).toBeInTheDocument();
    render(<DagView task={null as unknown as Task} />);
    expect(screen.getAllByText(/暂无任务/).length).toBe(2);
  });
});

describe('DagView 时间线模式（v1.3 Gantt）', () => {
  it('二段切换：默认结构；切时间线渲染 Gantt 与 5 档刻度', () => {
    render(<DagView task={TASK} />);
    expect(screen.getByTestId('dag-mode-structure')).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.dag-timeline')).toBeNull();
    fireEvent.click(screen.getByTestId('dag-mode-timeline'));
    expect(screen.getByTestId('dag-mode-timeline')).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.dag-timeline')).not.toBeNull();
    // 刻度 0/25/50/75/100%
    expect(screen.getAllByTestId('dag-tl-tick').length).toBe(5);
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('条形几何不变量：left/width 与 start/duration 对 total 归一一致', () => {
    render(<DagView task={TASK} />);
    fireEvent.click(screen.getByTestId('dag-mode-timeline'));
    // 时刻以 started_at 为准：s-0 起 0（时长 7412.7），s-1 起 7400（时长 3600）
    // total = max(end) = 7400 + 3600 = 11000ms
    const bar0 = screen.getByTestId(`dag-tl-bar-s-0`) as HTMLElement;
    expect(parseFloat(bar0.style.width)).toBeCloseTo((7412.7 / 11000) * 100, 1);
    expect(parseFloat(bar0.style.left)).toBeCloseTo(0, 5);
    const bar1 = screen.getByTestId(`dag-tl-bar-s-1`) as HTMLElement;
    expect(parseFloat(bar1.style.left)).toBeCloseTo((7400 / 11000) * 100, 1);
    expect(parseFloat(bar1.style.width)).toBeCloseTo((3600 / 11000) * 100, 1);
    // kind 色 + 悬停 title 含起止与时长
    expect(bar0).toHaveClass('dag-tl__bar--classical');
    expect(bar0.title).toContain('7.4s');
    expect(bar0.title).toContain('0ms');
    expect(bar1).toHaveClass('dag-tl__bar--quantum');
    // 未开始步骤（s-2）无条形
    expect(screen.queryByTestId('dag-tl-bar-s-2')).toBeNull();
    expect(screen.getByTestId('dag-tl-pending-s-2')).toBeInTheDocument();
  });

  it('运行中步骤条形随 now 增长（duration = now - started）', () => {
    const running: Task = {
      ...TASK,
      steps: [
        {
          ...TASK.steps[0],
          status: 'running',
          finished_at: null,
          duration_ms: null,
        },
      ],
    };
    render(<DagView task={running} />);
    fireEvent.click(screen.getByTestId('dag-mode-timeline'));
    const bar = screen.getByTestId('dag-tl-bar-s-0') as HTMLElement;
    expect(bar).toHaveClass('dag-tl__bar--running');
    // 单步运行中：条形占满轨道
    expect(parseFloat(bar.style.width)).toBeCloseTo(100, 3);
  });
});

describe('DagView 嵌套下钻（v1.3）', () => {
  it('⊕ 角标仅 subtask_id 非空节点渲染；点击加载子 DAG + 面包屑', async () => {
    const loadTask = vi.fn(async () => SUBTASK);
    render(<DagView task={TASK} loadTask={loadTask} />);
    expect(screen.queryByTestId('dag-drill-s-0')).toBeNull();
    fireEvent.click(screen.getByTestId('dag-drill-s-1'));
    await waitFor(() => {
      expect(screen.getByTestId('dag-node-ss-0')).toBeInTheDocument();
    });
    expect(loadTask).toHaveBeenCalledWith('t-sub');
    // 面包屑：根任务名 / 下钻步骤名；点击根返回
    expect(screen.getByTestId('dag-crumb-root')).toHaveTextContent('VQE 全流程');
    expect(screen.getByTestId('dag-crumb-1')).toHaveTextContent('VQE 线路执行');
    fireEvent.click(screen.getByTestId('dag-crumb-root'));
    expect(screen.queryByTestId('dag-node-ss-0')).toBeNull();
    expect(screen.getByTestId('dag-node-s-0')).toBeInTheDocument();
  });

  it('子图同样支持结构/时间线切换；Drawer 子任务链接可下钻', async () => {
    const loadTask = vi.fn(async () => SUBTASK);
    render(<DagView task={TASK} loadTask={loadTask} />);
    // 结构模式（默认）下钻 → 子图；切时间线 → 子图条形；再切回结构
    fireEvent.click(screen.getByTestId('dag-drill-s-1'));
    await waitFor(() => {
      expect(screen.getByTestId('dag-node-ss-0')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('dag-mode-timeline'));
    expect(screen.getByTestId('dag-tl-bar-ss-0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dag-mode-structure'));
    expect(screen.getByTestId('dag-node-ss-0')).toBeInTheDocument();

    // 返回根任务，经 Drawer 子任务链接再次下钻
    fireEvent.click(screen.getByTestId('dag-crumb-root'));
    fireEvent.click(screen.getByTestId('dag-node-s-1'));
    fireEvent.click(screen.getByTestId('dag-detail-subtask'));
    await waitFor(() => {
      expect(screen.getByTestId('dag-crumb-1')).toHaveTextContent('VQE 线路执行');
    });
  });

  it('loadTask 缺省时 ⊕ 点击静默降级（无崩溃）', () => {
    render(<DagView task={TASK} />);
    fireEvent.click(screen.getByTestId('dag-drill-s-1'));
    expect(screen.getByTestId('dag-node-s-0')).toBeInTheDocument();
  });
});

/** v1.4：queue_position 排队徽标 + Drawer 云端字段（cloud_job_id/circuit）。 */
describe('DagView v1.4 排队与云端字段', () => {
  const QUEUED: Task = {
    ...TASK,
    id: 't-q',
    steps: [
      {
        ...TASK.steps[1],
        id: 'sq-0',
        status: 'running',
        node_id: 'lq-mq02',
        queue_position: 3,
        cloud_job_id: 'lqjob-2049',
        circuit: {
          qubits: 2,
          operations: [
            { id: 'op-0', gate: 'RY', targets: [0] },
            { id: 'op-1', gate: 'CNOT', controls: [0], targets: [1] },
          ],
        },
      },
      { ...TASK.steps[2], id: 'sq-1', depends_on: ['sq-0'], queue_position: null },
    ],
  };

  it('queue_position 非空 → 节点「排队 #n」warning 徽标；null 节点无', () => {
    render(<DagView task={QUEUED} />);
    const badge = screen.getByTestId('dag-queue-sq-0');
    expect(badge).toHaveTextContent('排队 #3');
    expect(badge).toHaveClass('dag-node__queue');
    expect(screen.queryByTestId('dag-queue-sq-1')).toBeNull();
  });

  it('Drawer：cloud_job_id 与 circuit 摘要行（qubits/门数）', () => {
    render(<DagView task={QUEUED} />);
    fireEvent.click(screen.getByTestId('dag-node-sq-0'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer).toHaveTextContent('lqjob-2049');
    expect(drawer).toHaveTextContent('2 比特 · 2 门');
  });

  it('无云端字段步骤的 Drawer 不渲染空行', () => {
    render(<DagView task={TASK} />);
    fireEvent.click(screen.getByTestId('dag-node-s-0'));
    const drawer = screen.getByTestId('drawer');
    expect(drawer.querySelectorAll('[data-testid="dag-detail-cloud-job"]')).toHaveLength(0);
    expect(drawer.querySelectorAll('[data-testid="dag-detail-circuit"]')).toHaveLength(0);
  });
});
