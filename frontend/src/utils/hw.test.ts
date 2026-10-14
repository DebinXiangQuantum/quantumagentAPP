/**
 * hw.test.ts —— 硬件度量纯函数测试（design.md §6.4 v1.2 色阶阈值表）。
 *
 * 覆盖：
 *  1. fidelityLevel：三类指标（2Q/1Q/readout）阈值精确断言
 *     （2Q ≥0.992 绿 / ≥0.985 黄 / <0.985 红；1Q ≥0.999/≥0.995；
 *     readout ≥0.98/≥0.95）；
 *  2. usageLevel：≤0.8 normal / ≤0.9 warning / >0.9 danger（CPU/内存/VRAM 通用）；
 *  3. medianTqFidelity：奇偶样本中位数；空/畸形 → null；
 *  4. 度量格式化（§6.4 单位规范）：formatFidelity 2 位小数百分数、
 *     formatUs（µs 1 位小数）、formatGB（GB 1 位小数）——畸形输入 → "—"。
 */
import { describe, expect, it } from 'vitest';
import {
  fidelityLevel,
  formatFidelity,
  formatGB,
  formatUs,
  medianTqFidelity,
  usageLevel,
} from './hw';
import type { Coupler } from '../types/domain';

describe('fidelityLevel（保真度三档色阶，§6.4 阈值表）', () => {
  it('2Q 保真度：0.992→success；0.985→warning；0.9849→danger', () => {
    expect(fidelityLevel('2q', 0.992)).toBe('success');
    expect(fidelityLevel('2q', 0.9995)).toBe('success');
    expect(fidelityLevel('2q', 0.985)).toBe('warning');
    expect(fidelityLevel('2q', 0.987)).toBe('warning');
    expect(fidelityLevel('2q', 0.9849)).toBe('danger');
    expect(fidelityLevel('2q', 0.5)).toBe('danger');
  });
  it('1Q 保真度：0.999→success；0.995→warning；0.9949→danger', () => {
    expect(fidelityLevel('1q', 0.999)).toBe('success');
    expect(fidelityLevel('1q', 0.9993)).toBe('success');
    expect(fidelityLevel('1q', 0.995)).toBe('warning');
    expect(fidelityLevel('1q', 0.9961)).toBe('warning');
    expect(fidelityLevel('1q', 0.9949)).toBe('danger');
  });
  it('读出保真度：0.98→success；0.95→warning；0.949→danger', () => {
    expect(fidelityLevel('readout', 0.98)).toBe('success');
    expect(fidelityLevel('readout', 0.995)).toBe('success');
    expect(fidelityLevel('readout', 0.95)).toBe('warning');
    expect(fidelityLevel('readout', 0.97)).toBe('warning');
    expect(fidelityLevel('readout', 0.949)).toBe('danger');
  });
  it('畸形输入（NaN/字符串/越界）→ danger（最保守档）', () => {
    expect(fidelityLevel('2q', Number.NaN)).toBe('danger');
    expect(fidelityLevel('1q', '0.999' as unknown as number)).toBe('danger');
    expect(fidelityLevel('readout', 0)).toBe('danger');
    expect(fidelityLevel('readout', 1.5)).toBe('danger');
  });
});

describe('usageLevel（使用率告警色阶：≤0.8 / ≤0.9 / >0.9）', () => {
  it('0.8→normal；0.85→warning；0.9→warning；0.91→danger', () => {
    expect(usageLevel(0)).toBe('normal');
    expect(usageLevel(0.8)).toBe('normal');
    expect(usageLevel(0.85)).toBe('warning');
    expect(usageLevel(0.9)).toBe('warning');
    expect(usageLevel(0.91)).toBe('danger');
    expect(usageLevel(1)).toBe('danger');
  });
  it('畸形 → danger（防御式，不抛异常）', () => {
    expect(usageLevel(Number.NaN)).toBe('danger');
    expect(usageLevel(null)).toBe('danger');
    expect(usageLevel('0.5' as unknown as number)).toBe('danger');
  });
});

describe('medianTqFidelity（coupler 2Q 保真度中位数）', () => {
  const couplers = (vals: number[]): Coupler[] =>
    vals.map((v, i) => ({ a: i, b: i + 1, tq_fidelity: v }));

  it('奇数样本 → 正中值；偶数样本 → 中间两值平均', () => {
    expect(medianTqFidelity(couplers([0.99, 0.98, 0.995]))).toBeCloseTo(0.99, 10);
    expect(medianTqFidelity(couplers([0.99, 0.98, 0.995, 0.97]))).toBeCloseTo(
      0.985,
      10,
    );
  });
  it('空数组/畸形数组 → null（UI 降级显示）', () => {
    expect(medianTqFidelity([])).toBeNull();
    expect(medianTqFidelity(null)).toBeNull();
    expect(
      medianTqFidelity([{ a: 0, b: 1, tq_fidelity: Number.NaN }]),
    ).toBeNull();
  });
});

describe('度量格式化（§6.4 单位规范：保真度 2 位小数 / µs·GB 1 位小数）', () => {
  it('formatFidelity：0.9912→"99.12%"；0.9999→"99.99%"；畸形 → "—"', () => {
    expect(formatFidelity(0.9912)).toBe('99.12%');
    expect(formatFidelity(0.9999)).toBe('99.99%');
    expect(formatFidelity(0.978)).toBe('97.80%');
    expect(formatFidelity(null)).toBe('—');
    expect(formatFidelity(Number.NaN)).toBe('—');
    expect(formatFidelity('0.99' as unknown as number)).toBe('—');
  });
  it('formatUs：47.2→"47.2 µs"；31.55→"31.6 µs"（四舍五入）；畸形 → "—"', () => {
    expect(formatUs(47.2)).toBe('47.2 µs');
    expect(formatUs(31.55)).toBe('31.6 µs');
    expect(formatUs(0)).toBe('0.0 µs');
    expect(formatUs(Number.NaN)).toBe('—');
    expect(formatUs(null)).toBe('—');
  });
  it('formatGB：98.4→"98.4 GB"；256→"256.0 GB"；畸形 → "—"', () => {
    expect(formatGB(98.4)).toBe('98.4 GB');
    expect(formatGB(256)).toBe('256.0 GB');
    expect(formatGB(Number.NaN)).toBe('—');
    expect(formatGB(undefined)).toBe('—');
  });
});
