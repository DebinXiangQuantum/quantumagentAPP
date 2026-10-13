/**
 * CircuitCanvas.tsx —— 量子线路渲染器（手写 SVG，design.md §6.1）。
 *
 * 职责：
 *  - qubit 横线自上而下编号（等宽标签 q0…，间距 = cellH 36px）；
 *  - 门为格点方块（单位格 44×36）；CNOT 画控制点 + 竖线 + ⊕；
 *    MEASURE 画表针符号；列压缩无空列（utils/circuit 贪心）；
 *  - 悬停门高亮 + tooltip（gate/位号）；
 *  - >32 qubits 截断提示；越界/畸形门丢弃提示。
 * Props 契约：{ payload: unknown }——畸形载荷降级为提示文案，绝不抛异常。
 * 交互行为：mouseenter/leave 门组切换 tooltip；无键盘子交互（只读可视化）。
 */
import { useState } from 'react';
import { TOKENS } from '../../styles/tokens';
import { gateShape, layoutCircuit } from '../../utils/circuit';
import type { CircuitOperation } from '../../types/domain';

interface HoverState {
  op: CircuitOperation;
  cx: number;
  cy: number;
}

/** tooltip 文案：gate · q 位号（含控制位）。 */
function tooltipText(op: CircuitOperation): string {
  const targets = op.targets.map((t) => `q${t}`).join(' ');
  const controls = (op.controls ?? []).map((c) => `q${c}`).join(' ');
  if (op.gate.toUpperCase() === 'MEASURE') return `MEASURE · ${targets}`;
  if (controls.length > 0) return `${op.gate} · ctrl ${controls} → ${targets}`;
  return `${op.gate} · ${targets}`;
}

export function CircuitCanvas(props: { payload: unknown }): JSX.Element {
  const [hover, setHover] = useState<HoverState | null>(null);
  const layout = layoutCircuit(props.payload);

  if (!layout.ok) {
    return (
      <p className="viz-note viz-note--error" role="note">
        无法渲染线路：载荷不合法（qubits/operations 缺失或类型错误）
      </p>
    );
  }

  const { cellW, cellH, labelW, padY } = TOKENS.circuit;
  const width = labelW + Math.max(1, layout.columns) * cellW + 16;
  const height = padY * 2 + layout.qubits * cellH;
  const colX = (col: number): number => labelW + col * cellW + cellW / 2;
  const qY = (q: number): number => padY + q * cellH + cellH / 2;

  const renderGate = (op: CircuitOperation, col: number): JSX.Element => {
    const cx = colX(col);
    const shape = gateShape(op);
    const testId = `circuit-gate-${op.id || `${col}-${op.targets[0]}`}`;
    const handlers = {
      onMouseEnter: () => setHover({ op, cx, cy: qY(op.targets[0]) }),
      onMouseLeave: () => setHover(null),
    };

    if (shape === 'measure') {
      return (
        <g key={testId} data-testid={testId} data-col={col} {...handlers} className="circuit-gate">
          {op.targets.map((q) => {
            const y = qY(q);
            return (
              <g key={`m-${q}`}>
                {/* 表针：半圆弧 + 指针 */}
                <path
                  d={`M ${cx - 9} ${y + 5} A 9 9 0 0 1 ${cx + 9} ${y + 5} Z`}
                  fill="none"
                  strokeWidth="1.4"
                  className="circuit-stroke-accent"
                />
                <line
                  x1={cx}
                  y1={y + 5}
                  x2={cx + 6}
                  y2={y - 4}
                  strokeWidth="1.4"
                  className="circuit-stroke-accent"
                />
              </g>
            );
          })}
        </g>
      );
    }

    if (shape === 'controlled') {
      const controls = op.controls ?? [];
      const allQ = [...controls, ...op.targets].sort((a, b) => a - b);
      const top = qY(allQ[0]);
      const bottom = qY(allQ[allQ.length - 1]);
      const isCnot = /^CNOT$|^CX$/i.test(op.gate);
      return (
        <g key={testId} data-testid={testId} data-col={col} {...handlers} className="circuit-gate">
          <line
            x1={cx}
            y1={top}
            x2={cx}
            y2={bottom}
            strokeWidth="1.6"
            className="circuit-stroke-violet"
          />
          {controls.map((q) => (
            <circle key={`c-${q}`} cx={cx} cy={qY(q)} r="4" className="circuit-fill-violet" />
          ))}
          {op.targets.map((q) =>
            isCnot ? (
              <g key={`t-${q}`}>
                <circle
                  cx={cx}
                  cy={qY(q)}
                  r="9"
                  fill="none"
                  strokeWidth="1.6"
                  className="circuit-stroke-violet"
                />
                <line x1={cx - 9} y1={qY(q)} x2={cx + 9} y2={qY(q)} strokeWidth="1.6" className="circuit-stroke-violet" />
                <line x1={cx} y1={qY(q) - 9} x2={cx} y2={qY(q) + 9} strokeWidth="1.6" className="circuit-stroke-violet" />
              </g>
            ) : (
              <rect
                key={`t-${q}`}
                x={cx - cellW / 2 + 2}
                y={qY(q) - 14}
                width={cellW - 4}
                height={28}
                rx="4"
                className="circuit-box"
              />
            ),
          )}
          {!isCnot && op.targets.length > 0 ? (
            <text
              x={cx}
              y={qY(op.targets[0]) + 4}
              textAnchor="middle"
              className="circuit-gate-label mono"
            >
              {op.gate.slice(0, 4)}
            </text>
          ) : null}
        </g>
      );
    }

    // 单量子门：格点方块
    return (
      <g key={testId} data-testid={testId} data-col={col} {...handlers} className="circuit-gate">
        {op.targets.length === 1 ? (
          <>
            <rect
              x={cx - cellW / 2 + 2}
              y={qY(op.targets[0]) - 14}
              width={cellW - 4}
              height={28}
              rx="4"
              className="circuit-box"
            />
            <text
              x={cx}
              y={qY(op.targets[0]) + 4}
              textAnchor="middle"
              className="circuit-gate-label mono"
            >
              {op.gate.slice(0, 4)}
            </text>
          </>
        ) : (
          op.targets.map((q) => (
            <rect
              key={`t-${q}`}
              x={cx - cellW / 2 + 2}
              y={qY(q) - 14}
              width={cellW - 4}
              height={28}
              rx="4"
              className="circuit-box"
            />
          ))
        )}
      </g>
    );
  };

  return (
    <div className="circuit-wrap">
      {layout.truncated ? (
        <p className="viz-note" role="note">
          线路包含 {layout.totalQubits} 个 qubits（&gt;32），已截断显示前
          {' '}{TOKENS.circuit.maxQubits} 行。
        </p>
      ) : null}
      {layout.dropped > 0 ? (
        <p className="viz-note" role="note">
          已忽略 {layout.dropped} 个越界或畸形的操作。
        </p>
      ) : null}
      <div className="circuit-scroll">
        <svg
          data-testid="circuit-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`量子线路（${layout.qubits} qubits，${layout.columns} 列）`}
          className={hover ? 'circuit-svg circuit-svg--hover' : 'circuit-svg'}
        >
          {Array.from({ length: layout.qubits }, (_, q) => (
            <g key={`q-${q}`}>
              <text x={labelW - 8} y={qY(q) + 4} textAnchor="end" className="circuit-qubit-label mono">
                q{q}
              </text>
              <line
                data-testid="circuit-qubit-line"
                data-qubit={q}
                x1={labelW}
                y1={qY(q)}
                x2={width - 8}
                y2={qY(q)}
                className="circuit-wire"
              />
            </g>
          ))}
          {layout.placed.map(({ op, column }) => renderGate(op, column))}
        </svg>
        {hover ? (
          <div
            data-testid="circuit-tooltip"
            className="viz-tooltip mono"
            style={{ left: hover.cx + 12, top: hover.cy - 10 }}
          >
            {tooltipText(hover.op)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
