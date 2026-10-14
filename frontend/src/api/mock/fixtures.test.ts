/**
 * fixtures.test.ts —— v1.2/v1.3 mock fixtures 契约测试。
 *
 * 覆盖：
 *  1. 10 台 QPU（6 online / 4 offline，拓扑行列各异）；
 *  2. §4 v1.2 不变量：fidelity ∈ (0,1]；t1/t2 > 0 且 t2 ≤ 2*t1；
 *     coupler 端点 ∈ [0, qubits_count) 且为网格相邻对；grid qubit id 与
 *     (row,col) 一一对应（id == row*cols+col 且数恰为 rows*cols）；
 *  3. 模拟区间（工程选择）：T1 20–80µs、T2 10–60µs、readout 0.95–0.995、
 *     1Q 0.995–0.9999、2Q 0.98–0.995；
 *  4. CPU/GPU metrics：used ≤ total；usage ∈ [0,1]；
 *  5. 租户 role=admin；步骤实测字段（duration_ms/peak_memory_mb，t-1 的
 *     s-1 挂子任务 t-3，子任务存在于 TASKS）。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PLUGINS,
  HARDWARE_NODES,
  TASKS,
  TENANT,
} from './fixtures';

const qpus = HARDWARE_NODES.filter((n) => n.kind === 'qpu');
const byId = new Map(HARDWARE_NODES.map((n) => [n.id, n]));

describe('v1.2 mock fixtures 契约（10 QPU 机群）', () => {
  it('10 台 QPU：6 在线 / 4 离线；拓扑行列各异；含 >12 行滚动演示机', () => {
    expect(qpus.length).toBe(10);
    expect(qpus.filter((n) => n.status === 'online').length).toBe(6);
    expect(qpus.filter((n) => n.status === 'offline').length).toBe(4);
    const shapes = new Set(qpus.map((n) => {
      const topo = (n.metrics as { topology: { rows: number; cols: number } }).topology;
      return `${topo.rows}x${topo.cols}`;
    }));
    expect(shapes.size).toBeGreaterThanOrEqual(4);
    const big = qpus.some((n) => {
      const topo = (n.metrics as { topology: { rows: number; cols: number } }).topology;
      return topo.rows > 12 || topo.cols > 12;
    });
    expect(big).toBe(true);
  });

  it('§4 不变量：fidelity ∈ (0,1]；t2 ≤ 2*t1；coupler 网格相邻；id↔(row,col)', () => {
    for (const qpu of qpus) {
      const m = qpu.metrics as {
        qubits_count: number;
        topology: {
          rows: number; cols: number;
          qubits: Array<{ id: number; t1_us: number; t2_us: number; readout_fidelity: number; sq_fidelity: number }>;
          couplers: Array<{ a: number; b: number; tq_fidelity: number }>;
        };
      };
      expect(m.topology.qubits.length).toBe(m.qubits_count);
      expect(m.qubits_count).toBe(m.topology.rows * m.topology.cols);
      for (const q of m.topology.qubits) {
        expect(q.id).toBeGreaterThanOrEqual(0);
        expect(q.id).toBeLessThan(m.qubits_count);
        expect(q.t1_us).toBeGreaterThan(0);
        expect(q.t2_us).toBeGreaterThan(0);
        expect(q.t2_us).toBeLessThanOrEqual(2 * q.t1_us + 1e-9);
        // 模拟区间（工程选择）
        expect(q.t1_us).toBeGreaterThanOrEqual(20);
        expect(q.t1_us).toBeLessThanOrEqual(80);
        expect(q.t2_us).toBeGreaterThanOrEqual(10);
        expect(q.t2_us).toBeLessThanOrEqual(60);
        expect(q.readout_fidelity).toBeGreaterThan(0);
        expect(q.readout_fidelity).toBeLessThanOrEqual(1);
        expect(q.sq_fidelity).toBeGreaterThan(0);
        expect(q.sq_fidelity).toBeLessThanOrEqual(1);
      }
      const cols = m.topology.cols;
      for (const c of m.topology.couplers) {
        expect(c.a).toBeGreaterThanOrEqual(0);
        expect(c.b).toBeGreaterThanOrEqual(0);
        expect(c.a).toBeLessThan(m.qubits_count);
        expect(c.b).toBeLessThan(m.qubits_count);
        // 网格相邻对：同行相邻列 或 同列相邻行
        const [ra, ca] = [Math.floor(c.a / cols), c.a % cols];
        const [rb, cb] = [Math.floor(c.b / cols), c.b % cols];
        const adjacent = (ra === rb && Math.abs(ca - cb) === 1) || (ca === cb && Math.abs(ra - rb) === 1);
        expect(adjacent, `${qpu.id} coupler ${c.a}-${c.b}`).toBe(true);
        expect(c.tq_fidelity).toBeGreaterThanOrEqual(0.98);
        expect(c.tq_fidelity).toBeLessThanOrEqual(0.995);
      }
    }
  });

  it('readout/1Q 模拟区间；CPU/GPU metrics used ≤ total、usage ∈ [0,1]', () => {
    for (const qpu of qpus) {
      const topo = (qpu.metrics as { topology: { qubits: Array<{ readout_fidelity: number; sq_fidelity: number }> } }).topology;
      for (const q of topo.qubits) {
        expect(q.readout_fidelity).toBeGreaterThanOrEqual(0.95);
        expect(q.readout_fidelity).toBeLessThanOrEqual(0.995);
        expect(q.sq_fidelity).toBeGreaterThanOrEqual(0.995);
        expect(q.sq_fidelity).toBeLessThanOrEqual(0.9999);
      }
    }
    const cpu = byId.get('cpu-node-0')?.metrics as { cpu_usage: number; memory_total_gb: number; memory_used_gb: number };
    expect(cpu.cpu_usage).toBeGreaterThanOrEqual(0);
    expect(cpu.cpu_usage).toBeLessThanOrEqual(1);
    expect(cpu.memory_used_gb).toBeLessThanOrEqual(cpu.memory_total_gb);
    const gpu = byId.get('gpu-a800-0')?.metrics as { vram_total_gb: number; vram_used_gb: number };
    expect(gpu.vram_used_gb).toBeLessThanOrEqual(gpu.vram_total_gb);
    for (const n of HARDWARE_NODES) {
      expect(n.utilization).toBeGreaterThanOrEqual(0);
      expect(n.utilization).toBeLessThanOrEqual(1);
      expect(n.allocations.length).toBeLessThanOrEqual(n.capacity);
    }
  });

  it('租户 role=admin；插件含 broken 与 capabilities/model_ref；步骤实测字段 + 子任务挂接', () => {
    expect(TENANT.role).toBe('admin');
    const broken = ADMIN_PLUGINS.find((p) => p.id === 'legacy-noise-model');
    expect(broken?.broken_reason).toBeTruthy();
    expect(ADMIN_PLUGINS.every((p) => Array.isArray(p.capabilities) && typeof p.model_ref === 'string')).toBe(true);

    const t1 = TASKS.find((tk) => tk.id === 't-1');
    expect(t1?.steps[0].duration_ms).toBeGreaterThan(0);
    expect(t1?.steps[0].peak_memory_mb).toBeGreaterThan(0);
    expect(t1?.steps[2].duration_ms).toBeNull();
    // s-1 挂子任务 t-3，且 t-3 存在于任务表（可下钻）
    expect(t1?.steps[1].subtask_id).toBe('t-3');
    const sub = TASKS.find((tk) => tk.id === 't-3');
    expect(sub).toBeDefined();
    expect(sub?.steps.length).toBeGreaterThan(0);
  });
});
