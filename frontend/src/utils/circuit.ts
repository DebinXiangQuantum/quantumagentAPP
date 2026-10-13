/**
 * circuit.ts —— 量子线路布局纯函数（design.md §6.1 / ARCHITECTURE §6 约束）。
 *
 * 职责：
 *  - 防御式解析 circuit payload（qubits/operations 畸形一律降级）；
 *  - 越界/畸形门丢弃并计数（dropped），渲染层据此提示；
 *  - 列压缩贪心：门占用 targets ∪ controls 的 qubit 集合，寻找第一个
 *    无 qubit 冲突的列，否则新开列 —— 保证无空列；
 *  - >32 qubits 截断（display 只保留前 32 行）。
 * 失败行为：载荷不合法 → ok:false（组件渲染提示，不崩溃）。
 */
import type { CircuitOperation } from '../types/domain';
import { TOKENS } from '../styles/tokens';

export interface PlacedOp {
  op: CircuitOperation;
  column: number;
}

export interface CircuitLayoutResult {
  ok: boolean;
  /** 展示的 qubit 数（≤ maxQubits） */
  qubits: number;
  /** 载荷声明的原始 qubit 数 */
  totalQubits: number;
  truncated: boolean;
  columns: number;
  placed: PlacedOp[];
  dropped: number;
}

export const MAX_QUBITS = TOKENS.circuit.maxQubits; // 32

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

/** 单个 op 的防御式校验（返回 null 表示丢弃）。 */
function parseOp(raw: unknown, displayQubits: number, totalQubits: number): CircuitOperation | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Partial<CircuitOperation>;
  if (typeof o.gate !== 'string' || o.gate.length === 0) return null;
  if (!Array.isArray(o.targets) || o.targets.length === 0) return null;
  // 截断后不可见的 qubit 同样丢弃（计入 dropped）
  const inRange = (v: unknown): boolean => isInt(v) && v >= 0 && v < displayQubits;
  if (!o.targets.every(inRange)) {
    // 若仅因截断不可见（仍在 totalQubits 内）也丢弃，计数一致
    void totalQubits;
    return null;
  }
  const controls = Array.isArray(o.controls) ? o.controls.filter(isInt) : [];
  if (!controls.every((c) => c >= 0 && c < displayQubits)) return null;
  return { id: typeof o.id === 'string' ? o.id : '', gate: o.gate, targets: [...o.targets], controls };
}

export function layoutCircuit(payload: unknown): CircuitLayoutResult {
  const fail: CircuitLayoutResult = {
    ok: false, qubits: 0, totalQubits: 0, truncated: false, columns: 0, placed: [], dropped: 0,
  };
  if (payload === null || typeof payload !== 'object') return fail;
  const p = payload as { qubits?: unknown; operations?: unknown };
  if (!isInt(p.qubits) || p.qubits < 1) return fail;
  if (!Array.isArray(p.operations)) return fail;

  const totalQubits = p.qubits;
  const truncated = totalQubits > MAX_QUBITS;
  const displayQubits = truncated ? MAX_QUBITS : totalQubits;

  const placed: PlacedOp[] = [];
  let dropped = 0;
  const columnMasks: number[] = [];

  for (const rawOp of p.operations) {
    const op = parseOp(rawOp, displayQubits, totalQubits);
    if (!op) {
      dropped += 1;
      continue;
    }
    // qubit 位掩码：targets ∪ controls
    let mask = 0;
    for (const q of [...op.targets, ...(op.controls ?? [])]) mask |= 1 << q;
    // 贪心列压缩：第一个无冲突的列
    let col = columnMasks.findIndex((m) => (m & mask) === 0);
    if (col === -1) {
      columnMasks.push(0);
      col = columnMasks.length - 1;
    }
    columnMasks[col] |= mask;
    placed.push({ op, column: col });
  }

  return {
    ok: true,
    qubits: displayQubits,
    totalQubits,
    truncated,
    columns: columnMasks.length,
    placed,
    dropped,
  };
}

/** 门分类：测量 / 受控（CNOT 型）/ 单门。渲染层据此选择图形。 */
export type GateShape = 'measure' | 'controlled' | 'box';

export function gateShape(op: CircuitOperation): GateShape {
  if (op.gate.toUpperCase() === 'MEASURE') return 'measure';
  if ((op.controls?.length ?? 0) > 0) return 'controlled';
  return 'box';
}
