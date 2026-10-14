/**
 * QpuTopologyCanvas.tsx —— QPU 拓扑保真度图（design.md §6.4 v1.2，手写 SVG；
 * v1.4 增云端真机坐标点降级）。
 *
 * 职责：
 *  - grid 布局：qubit = 圆圈（内标 id，等宽），coupler = 连线；连线中点标
 *    2Q 保真度百分数、qubit 圈下方标 readout 百分数（全等宽 --font-data；
 *    §6.4 单位规范 2 位小数）；色阶（阈值表）圈描边按 readout 档、连线按
 *    2Q 档（utils/hw fidelityLevel）；图例三档置底；>12×12 → 滚动容器；
 *  - v1.4 云端降级（logicalcloud 真机无 couplers/保真度）：只渲染比特
 *    **坐标点**（按 topology.qubit_coordinates 摆放；无坐标回退 grid），
 *    coupler/readout 标注与图例全部隐藏；tooltip 显示
 *    「T1/T2/保真度：平台未提供」；单比特保真度缺省的混合数据同样逐元素
 *    降级（有 readout 的照常标注，缺省的只画圈）。
 * Props 契约：{ metrics: QpuMetrics }——畸形 qubit/coupler/坐标丢弃，不崩溃。
 * 失败行为：无有效拓扑（无 qubits 且坐标/网格均不可用）→ 降级提示行。
 */
import { useTranslate } from '../../i18n';
import { fidelityLevel, formatFidelity, formatUs } from '../../utils/hw';
import type { Coupler, QpuMetrics, QubitInfo } from '../../types/domain';

/** 网格/坐标单元边长（px）：圆 r=13 + 圈下标注空间。 */
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
function validFidelity(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
}

/** 坐标点（v1.4 云端拓扑）：有限非负数对，且与 qubits 数量一一对应。 */
function parseCoordinates(
  raw: unknown,
  qubitCount: number,
): Array<[number, number]> | null {
  if (!Array.isArray(raw) || raw.length !== qubitCount || qubitCount === 0) return null;
  const out: Array<[number, number]> = [];
  for (const item of raw) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      !Number.isFinite(item[0]) ||
      !Number.isFinite(item[1]) ||
      item[0] < 0 ||
      item[1] < 0
    ) {
      return null;
    }
    out.push([item[0], item[1]]);
  }
  return out;
}

/** 单比特保真度字段齐备（tooltip 全量信息可用）。 */
function qubitFidelityComplete(q: QubitInfo): boolean {
  return validFidelity(q.readout_fidelity) && validFidelity(q.sq_fidelity);
}

export function QpuTopologyCanvas(props: { metrics: QpuMetrics }): JSX.Element {
  const t = useTranslate();
  const topo = props.metrics?.topology;
  const qubits = Array.isArray(topo?.qubits) ? topo.qubits.filter(isQubit) : [];
  const couplers = Array.isArray(topo?.couplers) ? topo.couplers.filter(isCoupler) : [];
  const rows = Number.isFinite(topo?.rows) ? topo!.rows : 0;
  const cols = Number.isFinite(topo?.cols) ? topo!.cols : 0;
  const coordinates = parseCoordinates(topo?.qubit_coordinates, qubits.length);

  // 摆放来源：云端坐标点优先，回退 grid（rows×cols）
  const useCoords = coordinates !== null;
  const useGrid = !useCoords && rows > 0 && cols > 0;
  if (qubits.length === 0 || (!useCoords && !useGrid)) {
    return <p className="viz-note">{t('hw.topo.unavailable')}</p>;
  }

  // 画布几何：坐标模式按最大 (x,y) 推行列；网格模式直接 rows×cols
  const maxCol = useCoords
    ? Math.max(...coordinates!.map(([x]) => x))
    : cols - 1;
  const maxRow = useCoords
    ? Math.max(...coordinates!.map(([, y]) => y))
    : rows - 1;
  const width = (maxCol + 1) * CELL + PAD * 2;
  const height = (maxRow + 1) * CELL + PAD * 2;
  const posOf = (id: number): { x: number; y: number } => {
    if (useCoords) {
      const [x, y] = coordinates![id] ?? [0, 0];
      return { x: PAD + x * CELL + CELL / 2, y: PAD + y * CELL + CELL / 2 };
    }
    const r = Math.floor(id / cols);
    const c = id % cols;
    return { x: PAD + c * CELL + CELL / 2, y: PAD + r * CELL + CELL / 2 };
  };
  const scrollable = maxRow > SCROLL_LIMIT || maxCol > SCROLL_LIMIT;

  // v1.4 降级判定：无任何有效保真度样本 → 只画坐标点（连线/标注/图例全隐）
  const drawableCouplers = couplers.filter((c) => validFidelity(c.tq_fidelity));
  const anyReadout = qubits.some((q) => validFidelity(q.readout_fidelity));
  const fidelityRich = drawableCouplers.length > 0 || anyReadout;

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
        {fidelityRich
          ? drawableCouplers.map((c) => {
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
            })
          : null}
        {qubits.map((q) => {
          const p = posOf(q.id);
          const hasReadout = validFidelity(q.readout_fidelity);
          const level = hasReadout ? fidelityLevel('readout', q.readout_fidelity) : null;
          // v1.4：字段齐备 → 全量 tooltip；云端/缺省 → 「平台未提供」
          const tooltip = qubitFidelityComplete(q) && Number.isFinite(q.t1_us) && Number.isFinite(q.t2_us)
            ? t('hw.topo.tooltip', {
                id: q.id,
                t1: formatUs(q.t1_us),
                t2: formatUs(q.t2_us),
                sq: formatFidelity(q.sq_fidelity),
                ro: formatFidelity(q.readout_fidelity),
              })
            : t('hw.topo.notProvided', { id: q.id });
          return (
            <g
              key={`q-${q.id}`}
              className={level !== null ? `qpu-topo--${level}` : 'qpu-topo--bare'}
              data-testid={`qpu-topo-qubit-${q.id}`}
            >
              <title>{tooltip}</title>
              <circle cx={p.x} cy={p.y} r={RADIUS} className="qpu-topo__qubit" />
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="qpu-topo__qid mono">
                {q.id}
              </text>
              {hasReadout ? (
                <text
                  data-testid={`qpu-topo-readout-${q.id}`}
                  x={p.x}
                  y={p.y + RADIUS + 11}
                  textAnchor="middle"
                  className="qpu-topo__readout mono"
                >
                  {formatFidelity(q.readout_fidelity)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
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
