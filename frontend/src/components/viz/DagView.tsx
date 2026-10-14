/**
 * DagView.tsx —— 任务 DAG 视图（design.md §6.3 v1.3：时间分析 + 嵌套下钻）。
 *
 * 职责：
 *  - 结构模式（纵向流水线，§5.1 几何修订 v1.3 节点 232×92——增实测行）：
 *    节点 = Step：kind 色 + 统一 StatusBadge + 等宽 id + **实测标注**
 *    （`时长 413ms` / `内存 18.3MB`，--font-data；不可得 → "—"；
 *    来自后端 perf_counter/tracemalloc 实测（measured），UI 不称硬件观测）；
 *  - 时间线模式（水平 Gantt）：x=任务起点起算相对时间、条宽=duration_ms、
 *    kind 色；运行中条宽随 now 实时增长（250ms tick + ≤200ms CSS 过渡）；
 *    0/25/50/75/100% 刻度；悬停 title 含起止时刻与时长；未开始步骤无条形；
 *  - 嵌套下钻：subtask_id 非空节点显示 ⊕ 角标；点击经 loadTask 加载子任务
 *    DAG（同一组件递归渲染），面包屑「VQE 全流程 / 分子积分计算 / …」逐级
 *    返回；子图同样支持二段切换；
 *  - Drawer 详情：node_id/起止/detail/error + 实测时长/峰值内存/子任务链接；
 *  - 环/未知依赖/畸形任务防御式降级（invalid 提示），不崩溃。
 * Props 契约：{ task, loadTask? }——loadTask 由 InspectorPanel 注入
 *  （getApi().getTask）；缺省时 ⊕ 点击静默降级。
 */
import { useEffect, useMemo, useState } from 'react';
import { buildDagModel, buildTimelineModel } from '../../utils/dag';
import { StatusBadge } from '../common/StatusBadge';
import { Drawer } from '../common/Drawer';
import { formatClock, formatDuration, formatMb } from '../../utils/format';
import type { Step, Task } from '../../types/domain';
import { useTranslate } from '../../i18n';

// 布局几何（px；§6.3 纵向流水线 + 节点 232×92（v1.3 实测行））
const NODE_W = 232;
const NODE_H = 92;
const GAP_X = 16;
const GAP_Y = 24;
/** 画布在内容尺寸外的余量（px），保证边缘节点/箭头不被裁切 */
const CANVAS_MARGIN = 8;
/** 运行中条形增长的刷新间隔（视图重算 now；CSS 过渡 ≤200ms 平滑衔接）。 */
const RUNNING_TICK_MS = 250;
/** 时间线刻度档位（§6.3：0/25/50/75/100% 总时长）。 */
const TICK_PCTS = [0, 25, 50, 75, 100];

/** 下钻面包屑条目。 */
interface Crumb {
  taskId: string;
  /** 面包屑显示名（下钻来源步骤名或根任务名） */
  label: string;
  task: Task;
}

type DagMode = 'structure' | 'timeline';

function pctOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

export function DagView(props: {
  task: Task | null;
  loadTask?: (taskId: string) => Promise<Task | null>;
}): JSX.Element {
  const t = useTranslate();
  const [selected, setSelected] = useState<Step | null>(null);
  const [mode, setMode] = useState<DagMode>('structure');
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const rootTask = props.task;

  // 根任务变化（切换会话/任务）→ 退出下钻、回到结构模式
  useEffect(() => {
    setCrumbs([]);
    setSelected(null);
  }, [rootTask?.id]);

  // 当前展示的任务：下钻最深一层，否则根任务
  const task = crumbs.length > 0 ? crumbs[crumbs.length - 1].task : rootTask;

  const model = useMemo(
    () => buildDagModel(task !== null && typeof task === 'object' ? task.steps : null),
    [task],
  );
  const timeline = useMemo(
    () => buildTimelineModel(task !== null && typeof task === 'object' ? task.steps : null, nowTick),
    [task, nowTick],
  );

  // 运行中步骤 → 定时刷新 now 使时间线条形实时增长
  useEffect(() => {
    if (!timeline.hasRunning) return undefined;
    const timer = setInterval(() => setNowTick(Date.now()), RUNNING_TICK_MS);
    return () => clearInterval(timer);
  }, [timeline.hasRunning]);

  const drill = async (step: Step): Promise<void> => {
    if (!step.subtask_id || !props.loadTask) return;
    try {
      const sub = await props.loadTask(step.subtask_id);
      if (sub === null) return;
      setCrumbs((prev) => [
        ...prev,
        { taskId: step.subtask_id as string, label: step.name, task: sub },
      ]);
      setSelected(null);
    } catch {
      // 加载失败静默降级（下钻入口保留，不崩溃）
    }
  };

  if (!task || typeof task !== 'object' || model.nodes.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state__title">{t('dag.empty.title')}</p>
        <p className="empty-state__hint">{t('dag.empty.hint')}</p>
      </div>
    );
  }

  // —— 纵向布局几何 ——
  const maxInLayer = Math.max(...model.nodes.map((n) => n.indexInLayer + 1));
  const width = maxInLayer * NODE_W + (maxInLayer - 1) * GAP_X;
  const height = model.layers * NODE_H + (model.layers - 1) * GAP_Y;
  const xOf = (idx: number): number => idx * (NODE_W + GAP_X);
  const yOf = (layer: number): number => layer * (NODE_H + GAP_Y);
  const nodePos = new Map(
    model.nodes.map((n) => [n.step.id, { x: xOf(n.indexInLayer), y: yOf(n.layer) }]),
  );

  const modeSwitch = (
    <div className="segmented segmented--dag" role="group" aria-label={t('dag.mode.aria')}>
      <button
        type="button"
        role="tab"
        className="segmented__btn"
        data-testid="dag-mode-structure"
        aria-pressed={mode === 'structure'}
        onClick={() => setMode('structure')}
      >
        {t('dag.mode.structure')}
      </button>
      <button
        type="button"
        role="tab"
        className="segmented__btn"
        data-testid="dag-mode-timeline"
        aria-pressed={mode === 'timeline'}
        onClick={() => setMode('timeline')}
      >
        {t('dag.mode.timeline')}
      </button>
    </div>
  );

  const breadcrumb = (
    <nav className="dag-view__crumbs" aria-label={t('dag.crumbs.aria')}>
      <button
        type="button"
        className="dag-crumb dag-crumb--root"
        data-testid="dag-crumb-root"
        onClick={() => setCrumbs([])}
        title={rootTask?.name ?? task.name}
      >
        <span className="truncate">{rootTask?.name ?? task.name}</span>
      </button>
      {crumbs.map((c, i) => (
        <span key={c.taskId} className="dag-crumb__item">
          <span className="dag-crumb__sep" aria-hidden="true">/</span>
          <button
            type="button"
            className="dag-crumb"
            data-testid={`dag-crumb-${i + 1}`}
            aria-current={i === crumbs.length - 1 ? 'page' : undefined}
            onClick={() => setCrumbs(crumbs.slice(0, i + 1))}
            title={c.label}
          >
            <span className="truncate">{c.label}</span>
          </button>
        </span>
      ))}
    </nav>
  );

  return (
    <div className="dag-view">
      <div className="dag-view__header">
        <div className="dag-view__titles">
          <span className="dag-view__task-name truncate">{task.name}</span>
          <StatusBadge status={task.status} />
        </div>
        {modeSwitch}
      </div>
      {crumbs.length > 0 ? breadcrumb : null}
      {model.invalid ? (
        <p className="viz-note viz-note--error" role="note">
          {t('dag.invalid')}
        </p>
      ) : null}

      {mode === 'structure' ? (
        // 画布显式给内容尺寸：绝对定位的节点/SVG 不贡献流内高度
        <div
          className="dag-view__canvas"
          style={{ width: width + CANVAS_MARGIN, height: height + CANVAS_MARGIN }}
        >
          <svg
            className="dag-view__edges"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="dag-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 Z" className="dag-arrow-fill" />
              </marker>
            </defs>
            {model.edges.map((edge) => {
              const from = nodePos.get(edge.from);
              const to = nodePos.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W / 2;
              const y1 = from.y + NODE_H;
              const x2 = to.x + NODE_W / 2;
              const y2 = to.y - 2;
              const midY = (y1 + y2) / 2;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  data-testid={`dag-edge-${edge.from}-${edge.to}`}
                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  className="dag-edge"
                  markerEnd="url(#dag-arrow)"
                />
              );
            })}
          </svg>
          {model.nodes.map(({ step, layer, indexInLayer }) => (
            <button
              key={step.id}
              type="button"
              data-testid={`dag-node-${step.id}`}
              className={[
                'dag-node',
                `dag-node--${step.kind}`,
                step.status === 'running' ? 'dag-node--running' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left: xOf(indexInLayer), top: yOf(layer), width: NODE_W, height: NODE_H }}
              onClick={() => setSelected(step)}
              aria-label={t('dag.stepAria', { name: step.name, id: step.id })}
            >
              <span className="dag-node__head">
                <span className="dag-node__name clamp-2">{step.name}</span>
                {/* v1.4：云端排队位置徽标（warning 呼吸；排队期间经 task.updated 更新） */}
                {typeof step.queue_position === 'number' && Number.isFinite(step.queue_position) ? (
                  <span
                    className="dag-node__queue mono"
                    data-testid={`dag-queue-${step.id}`}
                    title={t('dag.queue.title')}
                  >
                    {t('dag.queue.badge', { n: step.queue_position })}
                  </span>
                ) : null}
                <StatusBadge status={step.status} />
              </span>
              <span className="dag-node__meta mono truncate">
                {step.id}{step.node_id ? ` · ${step.node_id}` : ''}
              </span>
              {/* 实测标注（measured；不可得 → "—"） */}
              <span className="dag-node__measured mono">
                {t('dag.measured.duration', { v: formatDuration(step.duration_ms ?? null) })}
                <span className="dag-node__measured-sep" aria-hidden="true">·</span>
                {t('dag.measured.memory', { v: formatMb(step.peak_memory_mb ?? null) })}
              </span>
              {step.subtask_id ? (
                <span
                  className="dag-node__drill"
                  data-testid={`dag-drill-${step.id}`}
                  role="button"
                  tabIndex={0}
                  title={t('dag.drill.title', { name: step.name })}
                  aria-label={t('dag.drill.title', { name: step.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    void drill(step);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      void drill(step);
                    }
                  }}
                >
                  ⊕
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="dag-timeline" data-testid="dag-timeline">
          <div className="dag-tl__axis" aria-hidden="true">
            {TICK_PCTS.map((p) => (
              <span
                key={p}
                className="dag-tl__tick"
                data-testid="dag-tl-tick"
                style={{ left: `${p}%` }}
              />
            ))}
          </div>
          <div className="dag-tl__scale mono" aria-hidden="true">
            {TICK_PCTS.map((p) => (
              <span key={p} className="dag-tl__scale-label" style={{ left: `${p}%` }}>
                {p}%
              </span>
            ))}
          </div>
          {timeline.rows.length === 0 ? (
            <p className="viz-note">{t('dag.timeline.noStarted')}</p>
          ) : (
            timeline.rows.map(({ step, startMs, durationMs }) => {
              const startPct = pctOf(startMs ?? 0, timeline.totalMs);
              const widthPct = pctOf(durationMs ?? 0, timeline.totalMs);
              return (
                <div key={step.id} className="dag-tl__row" data-testid={`dag-tl-row-${step.id}`}>
                  <span className="dag-tl__label truncate" title={step.name}>
                    {step.name}
                  </span>
                  <span className="dag-tl__track">
                    <span
                      className={[
                        'dag-tl__bar',
                        `dag-tl__bar--${step.kind}`,
                        step.status === 'running' ? 'dag-tl__bar--running' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-testid={`dag-tl-bar-${step.id}`}
                      style={{ left: `${startPct.toFixed(2)}%`, width: `${widthPct.toFixed(2)}%` }}
                      title={t('dag.timeline.hover', {
                        start: formatDuration(startMs ?? 0),
                        end: formatDuration((startMs ?? 0) + (durationMs ?? 0)),
                        duration: formatDuration(durationMs ?? 0),
                      })}
                    />
                  </span>
                  <span className="dag-tl__duration mono">{formatDuration(durationMs ?? null)}</span>
                </div>
              );
            })
          )}
          {/* 未开始步骤：无条形，仅列出（信息完备） */}
          {model.nodes
            .filter((n) => timeline.rows.every((r) => r.step.id !== n.step.id))
            .map(({ step }) => (
              <div key={step.id} className="dag-tl__row dag-tl__row--pending" data-testid={`dag-tl-pending-${step.id}`}>
                <span className="dag-tl__label truncate" title={step.name}>{step.name}</span>
                <span className="dag-tl__track">
                  <StatusBadge status={step.status} />
                </span>
                <span className="dag-tl__duration mono">—</span>
              </div>
            ))}
        </div>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? t('dag.detail.title', { id: selected.id }) : ''}
      >
        {selected ? (
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>{t('dag.detail.status')}</dt>
              <dd><StatusBadge status={selected.status} /></dd>
            </div>
            <div className="detail-list__row">
              <dt>{t('dag.detail.kind')}</dt>
              <dd className="mono">{selected.kind}</dd>
            </div>
            <div className="detail-list__row">
              <dt>{t('dag.detail.node')}</dt>
              <dd className="mono">{selected.node_id ?? t('dag.detail.nodeUnset')}</dd>
            </div>
            <div className="detail-list__row">
              <dt>{t('dag.detail.start')}</dt>
              <dd className="mono">{formatClock(selected.started_at)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>{t('dag.detail.end')}</dt>
              <dd className="mono">{formatClock(selected.finished_at)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>{t('dag.detail.duration')}</dt>
              <dd className="mono">{formatDuration(selected.duration_ms ?? null)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>{t('dag.detail.memory')}</dt>
              <dd className="mono">{formatMb(selected.peak_memory_mb ?? null)}</dd>
            </div>
            {typeof selected.cloud_job_id === 'string' && selected.cloud_job_id.length > 0 ? (
              <div className="detail-list__row">
                <dt>{t('dag.detail.cloudJob')}</dt>
                <dd className="mono" data-testid="dag-detail-cloud-job">
                  {selected.cloud_job_id}
                </dd>
              </div>
            ) : null}
            {selected.circuit && typeof selected.circuit === 'object' ? (
              <div className="detail-list__row">
                <dt>{t('dag.detail.circuit')}</dt>
                <dd className="mono" data-testid="dag-detail-circuit">
                  {t('dag.detail.circuitSummary', {
                    qubits: selected.circuit.qubits,
                    gates: Array.isArray(selected.circuit.operations)
                      ? selected.circuit.operations.length
                      : 0,
                  })}
                </dd>
              </div>
            ) : null}
            {typeof selected.queue_position === 'number' && Number.isFinite(selected.queue_position) ? (
              <div className="detail-list__row">
                <dt>{t('dag.detail.queue')}</dt>
                <dd className="mono">#{selected.queue_position}</dd>
              </div>
            ) : null}
            <div className="detail-list__row">
              <dt>{t('dag.detail.detail')}</dt>
              <dd>{selected.detail || t('dag.detail.none')}</dd>
            </div>
            {selected.subtask_id ? (
              <div className="detail-list__row">
                <dt>{t('dag.detail.subtask')}</dt>
                <dd>
                  <button
                    type="button"
                    className="btn btn--sm"
                    data-testid="dag-detail-subtask"
                    onClick={() => void drill(selected)}
                  >
                    {t('dag.detail.subtaskGo')}
                  </button>
                </dd>
              </div>
            ) : null}
            {selected.error ? (
              <div className="detail-list__row detail-list__row--error">
                <dt>{t('dag.detail.error')}</dt>
                <dd>{selected.error}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Drawer>
    </div>
  );
}
