/**
 * StatusBadge.test.tsx —— 统一状态徽标测试（design.md §6.5）。
 *
 * 覆盖：五种状态 → 对应修饰类与中文文案；未知状态按 pending 降级不崩溃。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';
import type { TaskStatus } from '../../types/domain';

const CASES: Array<[TaskStatus, string, string]> = [
  ['pending', '等待中', 'status-badge--pending'],
  ['running', '运行中', 'status-badge--running'],
  ['succeeded', '已成功', 'status-badge--succeeded'],
  ['failed', '已失败', 'status-badge--failed'],
  ['cancelled', '已取消', 'status-badge--cancelled'],
];

describe('StatusBadge', () => {
  it.each(CASES)('%s → %s（类 %s）', (status, label, cls) => {
    render(<StatusBadge status={status} />);
    const el = screen.getByText(label);
    expect(el.closest('.status-badge')).toHaveClass(cls);
  });

  it('未知状态降级为 pending 风格，不崩溃', () => {
    render(<StatusBadge status={'weird' as unknown as TaskStatus} />);
    expect(screen.getByText('等待中')).toBeInTheDocument();
  });
});
