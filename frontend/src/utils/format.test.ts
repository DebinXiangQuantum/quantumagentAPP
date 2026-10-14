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
import { formatBytes, formatClock, formatHM, formatDuration, formatPercent } from './format';

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

describe('formatBytes（附件/文件卡人类可读大小）', () => {
  it('B / KB / MB / GB 阶梯，1 位小数', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.0 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
  it('畸形输入 → "—"，不抛异常', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-10)).toBe('—');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes('1024' as unknown as number)).toBe('—');
  });
});

describe('formatDuration（DAG 实测时长，design.md §6.3）', () => {
  it('<1s → 取整毫秒；≥1s → 秒 1 位小数', () => {
    expect(formatDuration(412.7)).toBe('413ms');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999.4)).toBe('999ms');
    expect(formatDuration(1.8e3)).toBe('1.8s');
    expect(formatDuration(61_234)).toBe('61.2s');
  });
  it('null / 负数 / NaN → "—"（实测不可得降级）', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});
