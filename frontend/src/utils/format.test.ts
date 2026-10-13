/**
 * format.test.ts —— 展示层格式化助手测试。
 *
 * 覆盖：
 *  1. formatClock：合法 ISO → 本地 HH:MM:SS；畸形输入 → "—"；
 *  2. formatHM：合法 ISO → 本地 HH:MM（消息时间戳用，避免秒数噪音）；
 *     畸形输入（非串/空串/不可解析）一律 "—"，绝不抛异常；
 *  3. formatPercent：[0,1] → 整数百分比；越界 clamp；畸形 → "—"。
 */
import { describe, expect, it } from 'vitest';
import { formatClock, formatHM, formatPercent } from './format';

describe('formatClock', () => {
  it('合法 ISO 时间 → 本地 HH:MM:SS', () => {
    const d = new Date(2026, 9, 13, 7, 41, 5);
    expect(formatClock(d.toISOString())).toBe('07:41:05');
  });
  it('畸形输入 → "—"（null/undefined/空串/乱串）', () => {
    expect(formatClock(null)).toBe('—');
    expect(formatClock(undefined)).toBe('—');
    expect(formatClock('')).toBe('—');
    expect(formatClock('not-a-date')).toBe('—');
  });
});

describe('formatHM（消息时间戳）', () => {
  it('合法 ISO 时间 → 本地 HH:MM（无秒）', () => {
    const d = new Date(2026, 9, 13, 7, 41, 5);
    expect(formatHM(d.toISOString())).toBe('07:41');
  });
  it('畸形输入 → "—"，不抛异常', () => {
    expect(formatHM(null)).toBe('—');
    expect(formatHM(undefined)).toBe('—');
    expect(formatHM('')).toBe('—');
    expect(formatHM('not-a-date')).toBe('—');
    expect(formatHM(42 as unknown as string)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('[0,1] → 整数百分比', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.374)).toBe('37%');
    expect(formatPercent(1)).toBe('100%');
  });
  it('越界 clamp 到 [0,1]，畸形 → "—"', () => {
    expect(formatPercent(1.4)).toBe('100%');
    expect(formatPercent(-0.2)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatPercent('37' as unknown as number)).toBe('—');
  });
});
