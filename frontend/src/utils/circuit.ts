/**
 * circuit.ts —— 量子线路布局纯函数（design.md §6.1 v1.5 / ARCHITECTURE §6 约束）。
 *
 * 职责：
 *  - 防御式解析 circuit payload（qubits/operations 畸形一律降级）；
 *  - 越界/畸形门丢弃并计数（dropped），渲染层据此提示；
 *  - v1.5 params：有限数值数组保留（畸形滤除，空则 undefined——渲染层退化门名）；
 *  - v1.5 测量后防御：某比特 MEASURE 之后仍作用该比特（targets ∪ controls）
 *    的操作剔除并计入 droppedAfterMeasure（含于 dropped）——后端校验是第一道
 *    闸，此处为渲染层兜底（真实反馈：测量后接 CNOT 属非法线路）；
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
  /** v1.5：因“测量后仍作用该比特”被剔除的操作数（含于 dropped） */
  droppedAfterMeasure: number;
}

export const MAX_QUBITS = TOKENS.circuit.maxQubits; // 32

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

/** 单个 op 的防御式校验（返回 null 表示丢弃）。params 仅保留有限数值。 */
function parseOp(raw: unknown, displayQubits: number): CircuitOperation | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Partial<CircuitOperation>;
  if (typeof o.gate !== 'string' || o.gate.length === 0) return null;
  if (!Array.isArray(o.targets) || o.targets.length === 0) return null;
  // 截断后不可见的 qubit 同样丢弃（计入 dropped）
  const inRange = (v: unknown): boolean => isInt(v) && v >= 0 && v < displayQubits;
  if (!o.targets.every(inRange)) return null;
  const controls = Array.isArray(o.controls) ? o.controls.filter(isInt) : [];
  if (!controls.every((c) => c >= 0 && c < displayQubits)) return null;
  // v1.5 params：非数组/全畸形 → undefined（调用方退化显示门名）
  const finite = Array.isArray(o.params)
    ? o.params.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [];
  return {
    id: typeof o.id === 'string' ? o.id : '',
    gate: o.gate,
    targets: [...o.targets],
    controls,
    ...(finite.length > 0 ? { params: finite } : {}),
  };
}

export function layoutCircuit(payload: unknown): CircuitLayoutResult {
  const fail: CircuitLayoutResult = {
    ok: false, qubits: 0, totalQubits: 0, truncated: false, columns: 0,
    placed: [], dropped: 0, droppedAfterMeasure: 0,
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
  let droppedAfterMeasure = 0;
  const columnMasks: number[] = [];
  // v1.5 测量后不变量：比特一旦 MEASURE，后续作用它的操作全部剔除
  const measuredQubits = new Set<number>();

  for (const rawOp of p.operations) {
    const op = parseOp(rawOp, displayQubits);
    if (!op) {
      dropped += 1;
      continue;
    }
    const touched = [...op.targets, ...(op.controls ?? [])];
    if (touched.some((q) => measuredQubits.has(q))) {
      dropped += 1;
      droppedAfterMeasure += 1;
      continue;
    }
    if (op.gate.trim().toUpperCase() === 'MEASURE') {
      for (const q of op.targets) measuredQubits.add(q);
    }
    // qubit 位掩码：targets ∪ controls
    let mask = 0;
    for (const q of touched) mask |= 1 << q;
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
    droppedAfterMeasure,
  };
}

/** 门分类：测量 / 受控（CNOT·CZ 型）/ 两点竖线（RZZ·缺 controls 的 CZ）/ 单门方块。 */
export type GateShape = 'measure' | 'controlled' | 'twodot' | 'box';

export function gateShape(op: CircuitOperation): GateShape {
  const gate = op.gate.trim().toUpperCase();
  if (gate === 'MEASURE') return 'measure';
  if ((op.controls?.length ?? 0) > 0) return 'controlled';
  // v1.5：RZZ 契约形态（targets 恰 2、无 controls）；CZ 缺 controls 的宽容形态
  // 同样按两端实心点渲染（不画方块）
  if ((gate === 'RZZ' || gate === 'CZ') && op.targets.length >= 2) return 'twodot';
  return 'box';
}

/**
 * v1.5 旋转门角度标签：params[0] 为有限**非负**值 → 两位小数字符串；
 * 缺失/畸形/负值 → null（调用方退化为仅门名，不崩溃）。
 * 负角度按畸形降级是渲染层约定（后端契约 θ 为有限角度，负值视为异常输入）。
 */
export function angleLabelOf(op: CircuitOperation): string | null {
  const v = op.params?.[0];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v.toFixed(2);
}
