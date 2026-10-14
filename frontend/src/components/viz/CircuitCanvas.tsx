/**
 * CircuitCanvas.tsx —— 量子线路渲染器（手写 SVG，design.md §6.1）。
 *
 * 职责：
 *  - qubit 横线自上而下编号（等宽标签 q0…，间距 = cellH 36px）；
 *  - 门为格点方块（单位格 44×36）；CNOT 画控制点 + 竖线 + ⊕；
 *    MEASURE 画表针符号；列压缩无空列（utils/circuit 贪心）；
 *  - v1.5 符号修订：CZ = 竖线 + 两端实心圆点（控制点样式，无 ⊕ 无方块）；
 *    RZZ(θ) = 竖线 + 两端实心点 + 线中点标签 RZZ(θ)（θ=params[0] 两位小数，
 *    缺失退化门名）；单比特旋转门（RX/RY/RZ）显示角度 RX(0.11)；
 *  - 悬停门高亮 + tooltip（gate/角度/位号）；
 *  - >32 qubits 截断提示；越界/畸形门丢弃提示；
 *  - v1.5 测量后防御：测量后仍作用该比特的操作由布局层剔除（dropped），
 *    此处追加独立提示（后端校验是第一道闸，渲染层兜底）。
 * Props 契约：{ payload: unknown }——畸形载荷降级为提示文案，绝不抛异常。
 * 交互行为：mouseenter/leave 门组切换 tooltip；无键盘子交互（只读可视化）。
 */
import { useState } from 'react';
import { TOKENS } from '../../styles/tokens';
import { angleLabelOf, gateShape, layoutCircuit } from '../../utils/circuit';
import { useTranslate } from '../../i18n';
import type { CircuitOperation } from '../../types/domain';

interface HoverState {
  op: CircuitOperation;
  cx: number;
  cy: number;
}

/** 旋转门（RX/RY/RZ）判定（大小写归一，后端真机实测可能产出小写门名）。 */
function isRotationGate(gate: string): boolean {
  return /^R[XYZ]$/.test(gate.trim().toUpperCase());
}

/** 门显示名：旋转门带角度 RX(0.11)；其余截 4 字符并大写归一。 */
function gateLabel(op: CircuitOperation): string {
  const name = op.gate.trim().toUpperCase();
  if (isRotationGate(op.gate) || name === 'RZZ') {
    const angle = angleLabelOf(op);
    return angle !== null ? `${name}(${angle})` : name;
  }
  return name.slice(0, 4);
}

/** tooltip 文案：gate(角度) · q 位号（含控制位）。 */
function tooltipText(op: CircuitOperation): string {
  const targets = op.targets.map((t) => `q${t}`).join(' ');
  const controls = (op.controls ?? []).map((c) => `q${c}`).join(' ');
  const label = gateLabel(op);
  if (op.gate.trim().toUpperCase() === 'MEASURE') return `MEASURE · ${targets}`;
  if (controls.length > 0) return `${label} · ctrl ${controls} → ${targets}`;
  return `${label} · ${targets}`;
}

export function CircuitCanvas(props: { payload: unknown }): JSX.Element {
  const t = useTranslate();
  const [hover, setHover] = useState<HoverState | null>(null);
  const layout = layoutCircuit(props.payload);

  if (!layout.ok) {
    return (
      <p className="viz-note viz-note--error" role="note">
        {t('circuit.note.invalid')}
      </p>
    );
  }

  const { cellW, cellH, labelW, padY } = TOKENS.circuit;
  const width = labelW + Math.max(1, layout.columns) * cellW + 16;
  const height = padY * 2 + layout.qubits * cellH;
  const colX = (col: number): number => labelW + col * cellW + cellW / 2;
  const qY = (q: number): number => padY + q * cellH + cellH / 2;

  // 每个 qubit 的导线终点：默认延伸到画布右缘；末操作是 MEASURE 的 qubit，
  // 导线在表针符号（半径 9）右侧 5px 收束——拖尾导线会显得"未完成"（视觉评审）
  const wireEndX = new Map<number, number>();
  for (let q = 0; q < layout.qubits; q += 1) {
    let lastCol = -1;
    let lastIsMeasure = false;
    for (const placed of layout.placed) {
      const touches =
        placed.op.targets.includes(q) || (placed.op.controls ?? []).includes(q);
      if (touches) {
        lastCol = placed.column;
        lastIsMeasure = placed.op.gate.trim().toUpperCase() === 'MEASURE';
      }
    }
    wireEndX.set(q, lastIsMeasure && lastCol >= 0 ? colX(lastCol) + 14 : width - 8);
  }

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

    // v1.5 两点符号（RZZ / 缺 controls 的 CZ）：竖线 + 两端实心点；
    // RZZ 在线中点标注 RZZ(θ)（等宽），CZ 宽容形态不标注
    if (shape === 'twodot') {
      const allQ = [...op.targets].sort((a, b) => a - b);
      const top = qY(allQ[0]);
      const bottom = qY(allQ[allQ.length - 1]);
      const isRzz = op.gate.trim().toUpperCase() === 'RZZ';
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
          {allQ.map((q) => (
            <circle key={`d-${q}`} cx={cx} cy={qY(q)} r="4" className="circuit-fill-violet" />
          ))}
          {isRzz ? (
            <text
              x={cx}
              y={(top + bottom) / 2 + 4}
              textAnchor="middle"
              className="circuit-gate-label mono"
            >
              {gateLabel(op)}
            </text>
          ) : null}
        </g>
      );
    }

    if (shape === 'controlled') {
      const controls = op.controls ?? [];
      const allQ = [...controls, ...op.targets].sort((a, b) => a - b);
      const top = qY(allQ[0]);
      const bottom = qY(allQ[allQ.length - 1]);
      const gate = op.gate.trim().toUpperCase();
      const isCnot = gate === 'CNOT' || gate === 'CX';
      // v1.5 CZ：竖线 + 两端实心圆点（复用控制点样式；无 ⊕、无方块、无标签）
      if (gate === 'CZ') {
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
            {allQ.map((q) => (
              <circle key={`cz-${q}`} cx={cx} cy={qY(q)} r="4" className="circuit-fill-violet" />
            ))}
          </g>
        );
      }
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
              {gateLabel(op)}
            </text>
          ) : null}
        </g>
      );
    }

    // 单量子门：格点方块（v1.5 旋转门标签带角度）
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
              {gateLabel(op)}
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
          {t('circuit.note.truncated', { total: layout.totalQubits, max: TOKENS.circuit.maxQubits })}
        </p>
      ) : null}
      {layout.dropped > 0 ? (
        <p className="viz-note" role="note">
          {t('circuit.note.dropped', { n: layout.dropped })}
        </p>
      ) : null}
      {layout.droppedAfterMeasure > 0 ? (
        <p className="viz-note" role="note">
          {t('circuit.note.postMeasure', { n: layout.droppedAfterMeasure })}
        </p>
      ) : null}
      <div className="circuit-scroll">
        <svg
          data-testid="circuit-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('circuit.aria', { qubits: layout.qubits, columns: layout.columns })}
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
                x2={wireEndX.get(q) ?? width - 8}
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
