/**
 * StatusBadge.tsx —— 统一状态徽标（design.md §6.5，全组件复用）。
 *
 * 职责：pending 空心 / running warning 呼吸 / succeeded success /
 *      failed danger / cancelled faint。
 * Props 契约：{ status: TaskStatus }——未知值降级为 pending 风格，不崩溃。
 * 交互行为：纯展示。
 */
import type { TaskStatus } from '../../types/domain';
import { useTranslate } from '../../i18n';

/** 状态 → i18n key（全组件统一复用同一徽标文案）。 */
const STATUS_KEYS: Record<TaskStatus, string> = {
  pending: 'status.pending',
  running: 'status.running',
  succeeded: 'status.succeeded',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
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
  const t = useTranslate();
  const status = parseTaskStatus(props.status);
  return (
    <span className={`status-badge status-badge--${status}`} title={status}>
      <span className="status-badge__dot" aria-hidden="true" />
      {t(STATUS_KEYS[status])}
    </span>
  );
}
