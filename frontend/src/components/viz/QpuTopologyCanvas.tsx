/**
 * QpuTopologyCanvas.tsx —— QPU 拓扑保真度图（design.md §6.4 v1.2，手写 SVG）。
 *
 * 职责：
 *  - grid 布局：qubit = 圆圈（内标 id，等宽），coupler = 连线；
 *  - 连线中点标 2Q 保真度百分数、qubit 圈下方标 readout 百分数（全等宽
 *    --font-data；§6.4 单位规范 2 位小数）；
 *  - 色阶（阈值表）：圈描边按 readout 档、连线按 2Q 档（success/warning/
 *    danger 三档，utils/hw fidelityLevel）；
 *  - 悬停 qubit → <title> tooltip（T1/T2 µs、1Q/readout 保真度）；
 *  - 图例三档置底；>12×12 网格 → 滚动容器（overflow）。
 * Props 契约：{ metrics: QpuMetrics }——畸形 qubit/coupler 丢弃，不崩溃。
 * 失败行为：无有效拓扑 → 降级提示行。
 */
import { useTranslate } from '../../i18n';
import { fidelityLevel, formatFidelity, formatUs } from '../../utils/hw';
import type { Coupler, QpuMetrics, QubitInfo } from '../../types/domain';

/** 网格单元边长（px）：圆 r=13 + 圈下标注空间。 */
const CELL = 62;
const RADIUS = 13;
/** 左/上留白（刻度与边缘标注不裁切）。 */
const PAD = 10;
/** 超过该行列数 → 滚动容器（§6.4）。 */
const SCROLL_LIMIT = 12;

function isQubit(v: unknown): v is QubitInfo {
  return v !== null && typeof v === 'object' && typeof (v as QubitInfo).id === 'number';
}
function isCoupler(v: unknown): v is Coupler {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as Coupler).a === 'number' &&
    typeof (v as Coupler).b === 'number'
  );
}

export function QpuTopologyCanvas(props: { metrics: QpuMetrics }): JSX.Element {
  const t = useTranslate();
  const topo = props.metrics?.topology;
  const qubits = Array.isArray(topo?.qubits) ? topo.qubits.filter(isQubit) : [];
  const couplers = Array.isArray(topo?.couplers) ? topo.couplers.filter(isCoupler) : [];
  const rows = Number.isFinite(topo?.rows) ? topo!.rows : 0;
  const cols = Number.isFinite(topo?.cols) ? topo!.cols : 0;

  if (qubits.length === 0 || rows <= 0 || cols <= 0) {
    return <p className="viz-note">{t('hw.topo.unavailable')}</p>;
  }

  const width = cols * CELL + PAD * 2;
  const height = rows * CELL + PAD * 2;
  const posOf = (id: number): { x: number; y: number } => {
    const r = Math.floor(id / cols);
    const c = id % cols;
    return { x: PAD + c * CELL + CELL / 2, y: PAD + r * CELL + CELL / 2 };
  };
  const scrollable = rows > SCROLL_LIMIT || cols > SCROLL_LIMIT;

  return (
    <div
      className="qpu-topo__scroll"
      data-testid="qpu-topo-scroll"
      data-scrollable={String(scrollable)}
    >
      <svg
        className="qpu-topo"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('hw.topo.aria', { count: qubits.length })}
      >
        {couplers.map((c) => {
          const p1 = posOf(c.a);
          const p2 = posOf(c.b);
          const level = fidelityLevel('2q', c.tq_fidelity);
          return (
            <g key={`c-${c.a}-${c.b}`} className={`qpu-topo--${level}`} data-testid={`qpu-topo-coupler-${c.a}-${c.b}`}>
              <line
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                strokeWidth={2}
                className="qpu-topo__coupler"
              />
              <text
                data-testid={`qpu-topo-tq-${c.a}-${c.b}`}
                x={(p1.x + p2.x) / 2}
                y={(p1.y + p2.y) / 2 - 3}
                textAnchor="middle"
                className="qpu-topo__tq mono"
              >
                {formatFidelity(c.tq_fidelity)}
              </text>
            </g>
          );
        })}
        {qubits.map((q) => {
          const p = posOf(q.id);
          const level = fidelityLevel('readout', q.readout_fidelity);
          return (
            <g key={`q-${q.id}`} className={`qpu-topo--${level}`} data-testid={`qpu-topo-qubit-${q.id}`}>
              <title>
                {t('hw.topo.tooltip', {
                  id: q.id,
                  t1: formatUs(q.t1_us),
                  t2: formatUs(q.t2_us),
                  sq: formatFidelity(q.sq_fidelity),
                  ro: formatFidelity(q.readout_fidelity),
                })}
              </title>
              <circle cx={p.x} cy={p.y} r={RADIUS} className="qpu-topo__qubit" />
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="qpu-topo__qid mono">
                {q.id}
              </text>
              <text
                data-testid={`qpu-topo-readout-${q.id}`}
                x={p.x}
                y={p.y + RADIUS + 11}
                textAnchor="middle"
                className="qpu-topo__readout mono"
              >
                {formatFidelity(q.readout_fidelity)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="qpu-topo__legend" aria-hidden="true">
        <span className="qpu-topo__legend-item" data-testid="qpu-topo-legend-item">
          <span className="qpu-topo__swatch qpu-topo--success" />
          {t('hw.topo.legend.good')}
        </span>
        <span className="qpu-topo__legend-item" data-testid="qpu-topo-legend-item">
          <span className="qpu-topo__swatch qpu-topo--success qpu-topo--warning" />
          {t('hw.topo.legend.fair')}
        </span>
        <span className="qpu-topo__legend-item" data-testid="qpu-topo-legend-item">
          <span className="qpu-topo__swatch qpu-topo--success qpu-topo--danger" />
          {t('hw.topo.legend.poor')}
        </span>
      </div>
    </div>
  );
}
