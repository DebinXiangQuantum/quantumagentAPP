/**
 * format.ts —— 展示层格式化工具（纯函数，全部类型注解 + 防御式）。
 */

/** 相对时间：xx 分钟/小时/天前；异常输入返回 '—'。 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diffSec = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86_400)} 天前`;
}

/** 本地时间 HH:MM:SS（等宽场景）；异常输入返回 '—'。 */
export function formatClock(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 百分比：0.37 → "37%"（clamp [0,1]，畸形输入返回 "—"）。 */
export function formatPercent(util: unknown): string {
  const n = typeof util === 'number' && Number.isFinite(util) ? util : NaN;
  if (Number.isNaN(n)) return '—';
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}
