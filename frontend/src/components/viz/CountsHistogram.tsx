/**
 * CountsHistogram.tsx —— 测量计数直方图（手写 SVG，design.md §6.2）。
 *
 * 职责：
 *  - 归一化条形：h = count / maxCount × plotH（不变量：最高条 == 绘图高）；
 *  - 条形 160ms 生长（CSS bar-grow，reduced-motion 全局降级）；
 *  - 横轴比特串（等宽），纵轴计数刻度（0 / 半高 / 最大）；
 *  - hover：tooltip 显示 比特串 · 计数 · 占比；副标题显示总 shots。
 * Props 契约：{ payload: unknown }——空数据 → 空态文案；畸形 → 错误提示，
 *  均不崩溃。
 */
import { useState } from 'react';
import { formatPercent } from '../../utils/format';

type Entry = { bitstring: string; count: number };

interface CountsModel {
  entries: Entry[];
  shots: number;
  qubits: number;
  maxCount: number;
}

/**
 * 防御式解析：
 *  - 'empty'：结构合法但无有效数据（空 counts / 全零）；
 *  - null：结构非法（非对象/shots 非正/计数值为负或非有限/键非串）。
 */
export function normalizeCounts(payload: unknown): CountsModel | 'empty' | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as { shots?: unknown; qubits?: unknown; counts?: unknown };
  // 先解析 counts：空对象视为"无数据"（即使 shots 缺失也不算结构损坏）
  if (p.counts === null || typeof p.counts !== 'object' || Array.isArray(p.counts)) return null;
  const entries: Entry[] = [];
  for (const [key, value] of Object.entries(p.counts as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    entries.push({ bitstring: key, count: value });
  }
  if (entries.length === 0) return 'empty';
  const maxCount = Math.max(...entries.map((e) => e.count));
  if (maxCount <= 0) return 'empty';
  if (typeof p.shots !== 'number' || !Number.isFinite(p.shots) || p.shots <= 0) return null;
  // 降序排列；并列按比特串字典序稳定
  entries.sort((a, b) => b.count - a.count || (a.bitstring < b.bitstring ? -1 : 1));
  return {
    entries,
    shots: p.shots,
    qubits: typeof p.qubits === 'number' && Number.isFinite(p.qubits) ? p.qubits : 0,
    maxCount,
  };
}

// 绘图几何（px；SVG 用户单位，非布局间距 token）
const PLOT_H = 160;
const BAR_W = 32;
const GAP = 16;
const PAD_L = 48;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 24;
const LABEL_H = 16;

export function CountsHistogram(props: { payload: unknown }): JSX.Element {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const model = normalizeCounts(props.payload);

  if (model === null) {
    return (
      <p className="viz-note viz-note--error" role="note">
        无法解析计数：载荷不合法（shots/counts 缺失或值非有限）
      </p>
    );
  }
  if (model === 'empty') {
    return (
      <p className="viz-note" role="note">
        无测量数据（counts 为空或全零）。
      </p>
    );
  }

  const n = model.entries.length;
  const width = PAD_L + n * BAR_W + (n - 1) * GAP + PAD_R;
  const height = PAD_T + PLOT_H + PAD_B + LABEL_H;
  const barX = (i: number): number => PAD_L + i * (BAR_W + GAP);
  const barH = (count: number): number => (count / model.maxCount) * PLOT_H;

  const hovered = hoverIndex !== null ? model.entries[hoverIndex] : null;

  return (
    <div className="counts-wrap">
      <p className="counts-subtitle mono">
        总 shots <span className="counts-subtitle__value">{model.shots}</span>
        {model.qubits > 0 ? (
          <>
            {' '}· qubits <span className="counts-subtitle__value">{model.qubits}</span>
          </>
        ) : null}
      </p>
      <div className="counts-scroll">
        <svg
          data-testid="counts-plot"
          data-plot-height={PLOT_H}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`测量计数直方图（${n} 个结果，总 ${model.shots} shots）`}
          className="counts-svg"
        >
          {/* 纵轴刻度：最大值 / 半高 / 0 */}
          {[PLOT_H, PLOT_H / 2, 0].map((dy, i) => {
            const y = PAD_T + dy;
            const value = [model.maxCount, model.maxCount / 2, 0][i];
            return (
              <g key={`grid-${i}`}>
                <line
                  x1={PAD_L - 6}
                  y1={y}
                  x2={width - PAD_R}
                  y2={y}
                  className={i === 2 ? 'counts-axis' : 'counts-grid'}
                />
                <text
                  x={PAD_L - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="counts-axis-label mono"
                >
                  {Number.isInteger(value) ? value : value.toFixed(0)}
                </text>
              </g>
            );
          })}
          {model.entries.map((entry, i) => {
            const h = barH(entry.count);
            return (
              <g key={entry.bitstring}>
                <rect
                  data-testid={`counts-bar-${entry.bitstring}`}
                  className={`counts-bar bar-grow${hoverIndex === i ? ' counts-bar--hover' : ''}`}
                  data-count={entry.count}
                  data-height={h}
                  data-bitstring={entry.bitstring}
                  x={barX(i)}
                  y={PAD_T + PLOT_H - h}
                  width={BAR_W}
                  height={h}
                  onMouseEnter={() => setHoverIndex(i)}
                  onMouseLeave={() => setHoverIndex(null)}
                />
                <text
                  x={barX(i) + BAR_W / 2}
                  y={PAD_T + PLOT_H + PAD_B - 6}
                  textAnchor="middle"
                  className="counts-x-label mono"
                >
                  {entry.bitstring}
                </text>
              </g>
            );
          })}
        </svg>
        {hovered ? (
          <div
            data-testid="counts-tooltip"
            className="viz-tooltip mono"
            style={{ left: barX(hoverIndex ?? 0) + BAR_W / 2, top: PAD_T }}
          >
            {hovered.bitstring} · {hovered.count} ·{' '}
            {formatPercent(hovered.count / model.shots)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
