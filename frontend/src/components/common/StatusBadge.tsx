/**
 * StatusBadge.tsx —— 统一状态徽标（design.md §6.5，全组件复用）。
 *
 * 职责：pending 空心 / running warning 呼吸 / succeeded success /
 *      failed danger / cancelled faint。
 * Props 契约：{ status: TaskStatus }——未知值降级为 pending 风格，不崩溃。
 * 交互行为：纯展示。
 */
import type { TaskStatus } from '../../types/domain';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '等待中',
  running: '运行中',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
};

export function parseTaskStatus(raw: unknown): TaskStatus {
  return raw === 'running' ||
    raw === 'succeeded' ||
    raw === 'failed' ||
    raw === 'cancelled'
    ? raw
    : 'pending';
}

export function StatusBadge(props: { status: TaskStatus }): JSX.Element {
  const status = parseTaskStatus(props.status);
  return (
    <span className={`status-badge status-badge--${status}`} title={status}>
      <span className="status-badge__dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}
