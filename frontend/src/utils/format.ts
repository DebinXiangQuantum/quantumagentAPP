/**
 * format.ts —— 展示层格式化工具（纯函数，全部类型注解 + 防御式）。
 * 相对时间文案经 i18n（读当前语言；展示处由语言订阅组件重渲染时重新调用）。
 */
import { t } from '../i18n';

/** 相对时间：xx 分钟/小时/天前（i18n）；异常输入返回 '—'。 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  const diffSec = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
  if (diffSec < 60) return t('time.justNow');
  if (diffSec < 3600) return t('time.minAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86_400) return t('time.hourAgo', { n: Math.floor(diffSec / 3600) });
  return t('time.dayAgo', { n: Math.floor(diffSec / 86_400) });
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

/** 本地时间 HH:MM（消息时间戳——秒数对会话流是噪音）；异常输入返回 '—'。 */
export function formatHM(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 百分比：0.37 → "37%"（clamp [0,1]，畸形输入返回 "—"）。 */
export function formatPercent(util: unknown): string {
  const n = typeof util === 'number' && Number.isFinite(util) ? util : NaN;
  if (Number.isNaN(n)) return '—';
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

/** 人类可读字节数（附件/文件卡）：B → KB → MB → GB，1 位小数；畸形 → "—"。 */
export function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * 实测时长（design.md §6.3）：<1000ms → 取整毫秒（412.7 → "413ms"）；
 * ≥1000ms → 秒 1 位小数（1800 → "1.8s"）；null/负数/NaN → "—"（不可得降级）。
 */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
