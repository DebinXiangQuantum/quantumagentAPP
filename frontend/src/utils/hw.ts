/**
 * hw.ts —— 硬件度量纯函数（design.md §6.4 v1.2：色阶阈值表 + 单位规范）。
 *
 * 职责：
 *  - fidelityLevel：保真度三档色阶（2Q/1Q/readout 各自阈值，映射
 *    success/warning/danger 语义色）；
 *  - usageLevel：使用率告警色阶（≤0.8 normal / ≤0.9 warning / >0.9 danger，
 *    CPU/内存/VRAM 通用）；
 *  - medianTqFidelity：coupler 2Q 保真度中位数（QPU 卡副行与 Drawer 摘要用）；
 *  - formatFidelity / formatUs / formatGB：单位规范格式化（保真度百分数
 *    2 位小数、µs 与 GB 1 位小数，全部供等宽 --font-data 场景）。
 * 失败行为：全部防御式——NaN/非数值/越界 → 色阶取最保守档（danger）、
 *   格式化返回 "—"、中位数返回 null；绝不抛异常。
 */
import type { Coupler } from '../types/domain';

/** 保真度指标类别（§6.4 阈值表的三行）。 */
export type FidelityMetric = '2q' | '1q' | 'readout';
/** 色阶语义（与 token success/warning/danger 一一对应）。 */
export type FidelityLevel = 'success' | 'warning' | 'danger';
/** 使用率告警三档。 */
export type UsageLevel = 'normal' | 'warning' | 'danger';

/** §6.4 阈值表：[绿下限, 黄下限]（低于黄下限 → 红）。 */
const FIDELITY_THRESHOLDS: Record<FidelityMetric, readonly [number, number]> = {
  '2q': [0.992, 0.985],
  '1q': [0.999, 0.995],
  readout: [0.98, 0.95],
};

/** 数值守卫：有限数且在 (0, 1]（契约 §4：fidelity ∈ (0,1]）。 */
function isValidFidelity(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
}

/** 保真度三档色阶（畸形/越界 → danger 最保守档）。 */
export function fidelityLevel(metric: FidelityMetric, value: unknown): FidelityLevel {
  if (!isValidFidelity(value)) return 'danger';
  const [green, yellow] = FIDELITY_THRESHOLDS[metric] ?? FIDELITY_THRESHOLDS['2q'];
  if (value >= green) return 'success';
  if (value >= yellow) return 'warning';
  return 'danger';
}

/** 使用率告警色阶：≤0.8 normal / ≤0.9 warning / >0.9 danger；畸形 → danger。 */
export function usageLevel(value: unknown): UsageLevel {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'danger';
  if (value <= 0.8) return 'normal';
  if (value <= 0.9) return 'warning';
  return 'danger';
}

/**
 * coupler 2Q 保真度中位数（奇数取正中、偶数取中间两值平均）。
 * 空数组 / null / 任一样本畸形（非有限数或越界）→ null（UI 降级隐藏）。
 */
export function medianTqFidelity(
  couplers: readonly Coupler[] | null | undefined,
): number | null {
  if (!Array.isArray(couplers) || couplers.length === 0) return null;
  const values: number[] = [];
  for (const c of couplers) {
    if (c === null || typeof c !== 'object' || !isValidFidelity(c.tq_fidelity)) {
      return null;
    }
    values.push(c.tq_fidelity);
  }
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}

/** 有限数守卫（格式化共用于可空字段）。 */
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 保真度 → 百分数 2 位小数（0.9912 → "99.12%"）；畸形 → "—"。 */
export function formatFidelity(value: unknown): string {
  const v = finite(value);
  if (v === null) return '—';
  return `${(v * 100).toFixed(2)}%`;
}

/** T1/T2 相干时间（µs，1 位小数：47.2 → "47.2 µs"）；畸形 → "—"。 */
export function formatUs(value: unknown): string {
  const v = finite(value);
  if (v === null) return '—';
  return `${v.toFixed(1)} µs`;
}

/** 容量（GB，1 位小数：98.4 → "98.4 GB"）；畸形 → "—"。 */
export function formatGB(value: unknown): string {
  const v = finite(value);
  if (v === null) return '—';
  return `${v.toFixed(1)} GB`;
}
