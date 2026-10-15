/**
 * QpuTopologyCanvas.tsx —— QPU 芯片布局预览（IBM Quantum 风格，v1.8 重写）。
 *
 * 布局原则（用户明确要求对齐 IBM Quantum 的 QPU 展示）：
 *  - 比特画在**物理坐标**（QubitInfo.x/y，云端 qubit_coordinates 的镜像）——
 *    芯片什么样图就什么样（8x8 稀疏格 / heavy-hex 均自然呈现），绝无随机排布；
 *  - 耦合器只连接**物理紧邻**的比特对——来源是云端 coupling_map（真实邻接），
 *    非"距离近就算相邻"的猜测；
 *  - 图面干净（IBM 风）：每比特=统一圆圈+小编号；每耦合器=细连线；数值标注
 *    一律不印在图上——保真度用**颜色分档**表达，具体数值悬停查看。
 *
 * 着色（utils/hw fidelityLevel 阈值表）：连线按两比特门（CZ）保真度分档；
 * 比特圈描边按读出保真度分档；缺数据的元素退为中性色（诚实降级，不猜）。
 * 悬停 tooltip：比特 → T1/T2/单比特门/读出保真度；耦合器 → CZ 保真度。
 * 混合数据（部分有标定）逐元素降级。>12×12 网格 → 横向滚动容器。
 * Props 契约：{ metrics: QpuMetrics }——畸形 qubit/coupler 丢弃，不崩溃。
 */
import { useState } from 'react';
import { useTranslate } from '../../i18n';
import { fidelityLevel, formatFidelity, formatUs } from '../../utils/hw';
import type { Coupler, QpuMetrics, QubitInfo } from '../../types/domain';

/** 单元边长（px）：IBM 式紧凑芯片感（圆 r=11 + 圈间留白）。 */
const CELL = 46;
const RADIUS = 11;
/** 边缘留白（不裁切描边/hover 光圈）。 */
const PAD = 12;
/** 超过该行列数 → 滚动容器。 */
const SCROLL_LIMIT = 12;

/** 悬停目标（比特或耦合器）——芯片图的信息都走悬停，图面零文字噪音。 */
type HoverTarget =
  | { kind: 'qubit'; qubit: QubitInfo }
  | { kind: 'coupler'; coupler: Coupler };

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
function validFidelity(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
}

/** 单比特保真度字段齐备（悬停全量信息可用）。 */
function qubitFidelityComplete(q: QubitInfo): boolean {
  return validFidelity(q.readout_fidelity) && validFidelity(q.sq_fidelity);
}

export function QpuTopologyCanvas(props: { metrics: QpuMetrics }): JSX.Element {
  const t = useTranslate();
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const topo = props.metrics?.topology;
  const qubits = Array.isArray(topo?.qubits) ? topo.qubits.filter(isQubit) : [];
  const couplers = Array.isArray(topo?.couplers) ? topo.couplers.filter(isCoupler) : [];
  const rows = Number.isFinite(topo?.rows) ? topo!.rows : 0;
  const cols = Number.isFinite(topo?.cols) ? topo!.cols : 0;

  // 摆放来源（v1.8）：比特自带物理坐标优先；全部缺坐标 → grid（rows×cols，
  // 模拟机群的自生成坐标也走 x/y，此分支仅为畸形数据兜底）
  const anyCoords = qubits.some((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
  if (qubits.length === 0 || (!anyCoords && (rows < 1 || cols < 1))) {
    return <p className="viz-note">{t('hw.topo.unavailable')}</p>;
  }
  const gridPos = (id: number): { x: number; y: number } => ({
    x: id % Math.max(cols, 1),
    y: Math.floor(id / Math.max(cols, 1)),
  });

  const maxCol = Math.max(
    ...qubits.map((q) => (Number.isFinite(q.x) ? (q.x as number) : gridPos(q.id).x)),
  );
  const maxRow = Math.max(
    ...qubits.map((q) => (Number.isFinite(q.y) ? (q.y as number) : gridPos(q.id).y)),
  );
  const width = (maxCol + 1) * CELL + PAD * 2;
  const height = (maxRow + 1) * CELL + PAD * 2;
  const scrollable = maxRow > SCROLL_LIMIT || maxCol > SCROLL_LIMIT;

  // 降级判定：无任何有效保真度样本 → 中性色芯片（连线照画——邻接是事实）
  const anyEdgeFidelity = couplers.some((c) => validFidelity(c.tq_fidelity));
  const anyReadout = qubits.some((q) => validFidelity(q.readout_fidelity));
  const fidelityRich = anyEdgeFidelity || anyReadout;

  const placement = new Map<number, { px: number; py: number }>();
  for (const q of qubits) {
    const hasXY = Number.isFinite(q.x) && Number.isFinite(q.y);
    const g = hasXY
      ? { x: q.x as number, y: q.y as number }
      : gridPos(q.id);
    placement.set(q.id, {
      px: PAD + g.x * CELL + CELL / 2,
      py: PAD + g.y * CELL + CELL / 2,
    });
  }
  const at = (id: number) => placement.get(id) ?? { px: PAD, py: PAD };

  // 悬停浮层位置（跟随目标锚点，画布容器定位）
  const tipPos = (() => {
    if (hover === null) return null;
    if (hover.kind === 'qubit') return at(hover.qubit.id);
    const p1 = at(hover.coupler.a);
    const p2 = at(hover.coupler.b);
    return { px: (p1.px + p2.px) / 2, py: (p1.py + p2.py) / 2 };
  })();

  return (
    <div
      className="qpu-topo__scroll"
      data-testid="qpu-topo-scroll"
      data-scrollable={String(scrollable)}
      data-fidelity={String(fidelityRich)}
    >
      <svg
        className="qpu-topo"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('hw.topo.aria', { count: qubits.length })}
      >
        {/* 耦合器：物理邻接连线（全量绘制——邻接是云端事实；颜色按 CZ 档 */}
        {couplers.map((c) => {
          const p1 = at(c.a);
          const p2 = at(c.b);
          const level = validFidelity(c.tq_fidelity)
            ? fidelityLevel('2q', c.tq_fidelity)
            : 'bare';
          return (
            <line
              key={`c-${c.a}-${c.b}`}
              data-testid={`qpu-topo-coupler-${c.a}-${c.b}`}
              className={`qpu-topo__coupler qpu-topo--${level}`}
              x1={p1.px}
              y1={p1.py}
              x2={p2.px}
              y2={p2.py}
              strokeWidth={2.5}
              onMouseEnter={() => setHover({ kind: 'coupler', coupler: c })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {/* 比特：物理坐标圆圈 + 编号；描边按读出档（IBM 式零文字标注） */}
        {qubits.map((q) => {
          const p = at(q.id);
          const hasReadout = validFidelity(q.readout_fidelity);
          const level = hasReadout ? fidelityLevel('readout', q.readout_fidelity) : 'bare';
          return (
            <g
              key={`q-${q.id}`}
              className={`qpu-topo--${level}`}
              data-testid={`qpu-topo-qubit-${q.id}`}
              onMouseEnter={() => setHover({ kind: 'qubit', qubit: q })}
              onMouseLeave={() => setHover(null)}
            >
              <circle cx={p.px} cy={p.py} r={RADIUS} className="qpu-topo__qubit" />
              <text x={p.px} y={p.py + 3} textAnchor="middle" className="qpu-topo__qid mono">
                {q.id}
              </text>
            </g>
          );
        })}
      </svg>
      {/* 悬停浮层：比特 → T1/T2/1Q/读出；耦合器 → CZ 保真度（数值不上图） */}
      {hover !== null && tipPos !== null ? (
        <div
          data-testid="qpu-topo-tooltip"
          className="viz-tooltip mono qpu-topo__tip"
          style={{ left: tipPos.px + 14, top: tipPos.py - 12 }}
        >
          {hover.kind === 'qubit'
            ? qubitFidelityComplete(hover.qubit) &&
                Number.isFinite(hover.qubit.t1_us) &&
                Number.isFinite(hover.qubit.t2_us)
              ? t('hw.topo.tooltip', {
                  id: hover.qubit.id,
                  t1: formatUs(hover.qubit.t1_us),
                  t2: formatUs(hover.qubit.t2_us),
                  sq: formatFidelity(hover.qubit.sq_fidelity),
                  ro: formatFidelity(hover.qubit.readout_fidelity),
                })
              : t('hw.topo.notProvided', { id: hover.qubit.id })
            : validFidelity(hover.coupler.tq_fidelity)
              ? t('hw.topo.couplerTooltip', {
                  a: hover.coupler.a,
                  b: hover.coupler.b,
                  cz: formatFidelity(hover.coupler.tq_fidelity),
                })
              : t('hw.topo.couplerNotProvided', {
                  a: hover.coupler.a,
                  b: hover.coupler.b,
                })}
        </div>
      ) : null}
      {fidelityRich ? (
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
      ) : null}
    </div>
  );
}
