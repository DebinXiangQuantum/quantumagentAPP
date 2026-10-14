/**
 * HardwareTopology.tsx —— 异构硬件拓扑视图（design.md §6.4，v1.2 升级）。
 *
 * 职责：
 *  - 按 kind 分组（QPU/GPU/CPU）的卡片网格；**QPU 分组头 `QPU · 在线 6/10`**
 *    （离线计入总数）；离线卡降饱和 + 斜纹 + 离线徽标（不可调度）；
 *  - QPU 卡副行 `20Q · 2Q 保真度中位 99.1%`（等宽，metrics 缺省降级隐藏）；
 *  - CPU 卡：CPU 使用率 + 内存双迷你条；GPU 卡：VRAM 迷你条 + 既有利用率条
 *    （usageLevel 告警色阶 ≤0.8/≤0.9/>0.9 通用；正常档 CPU=info、内存/VRAM
 *    =accent-cyan，越限升 warning/danger）；
 *  - 点击 QPU 卡 → Drawer 内嵌 QpuTopologyCanvas（拓扑保真度图）+ 摘要行；
 *    CPU/GPU Drawer 补 metrics 数值；全部 metrics 缺字段逐行降级隐藏；
 *  - 活动分配徽标 / 容量点 / 利用率 sparkline（既有行为不变）。
 * Props 契约：
 *  - nodes: HardwareNode[]（畸形元素丢弃）；
 *  - tasks: Task[]（用于历史任务回溯）；
 *  - history: Record<nodeId, number[]>（利用率滚动窗口）。
 * 失败行为：空数组 → 插画式空态；全部防御式，不崩溃。
 */
import { useState } from 'react';
import { useTranslate } from '../../i18n';
import { Drawer } from '../common/Drawer';
import { StatusBadge } from '../common/StatusBadge';
import { formatPercent } from '../../utils/format';
import { formatGB, medianTqFidelity, usageLevel } from '../../utils/hw';
import type {
  CpuMetrics,
  GpuMetrics,
  HardwareNode,
  NodeKind,
  QpuMetrics,
  Task,
} from '../../types/domain';
import { QpuTopologyCanvas } from './QpuTopologyCanvas';

const KIND_ORDER: NodeKind[] = ['qpu', 'gpu', 'cpu'];
const KIND_LABELS: Record<NodeKind, string> = { qpu: 'QPU', gpu: 'GPU', cpu: 'CPU' };

function isNode(v: unknown): v is HardwareNode {
  return v !== null && typeof v === 'object' && typeof (v as HardwareNode).id === 'string';
}

/** metrics 形状守卫（§4：按 kind 不同；缺省/畸形 → null 逐行降级）。 */
function qpuMetricsOf(node: HardwareNode): QpuMetrics | null {
  const m = node.metrics;
  return m !== null && typeof m === 'object' && 'topology' in m ? (m as QpuMetrics) : null;
}

/** v1.4：logicalcloud 真机节点判定（id 前缀 lq-；在线/离线为云端真实状态）。 */
export function isCloudQpu(node: HardwareNode): boolean {
  return typeof node.id === 'string' && node.id.startsWith('lq-');
}
function cpuMetricsOf(node: HardwareNode): CpuMetrics | null {
  const m = node.metrics;
  return m !== null && typeof m === 'object' && 'cpu_usage' in m ? (m as CpuMetrics) : null;
}
function gpuMetricsOf(node: HardwareNode): GpuMetrics | null {
  const m = node.metrics;
  return m !== null && typeof m === 'object' && 'vram_total_gb' in m ? (m as GpuMetrics) : null;
}

/** 迷你条（CPU/内存/VRAM 共用）：label + 条 + 数值；usageLevel 告警着色。 */
function MiniBar(props: {
  label: string;
  pct: number;
  value: string;
  variant?: 'cpu' | 'vram';
}): JSX.Element {
  const level = usageLevel(props.pct);
  return (
    <span className={`hw-card__mini${props.variant ? ` hw-card__mini--${props.variant}` : ''}`}>
      <span className="hw-card__mini-label">{props.label}</span>
      <span className="hw-card__mini-bar" aria-hidden="true">
        <span
          className={`hw-card__mini-fill hw-mini-fill--${level}${props.variant === 'cpu' ? ' hw-mini-fill--cpu' : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, props.pct * 100)).toFixed(1)}%` }}
        />
      </span>
      <span className="hw-card__mini-num mono truncate">{props.value}</span>
    </span>
  );
}

/** 利用率 sparkline（SVG polyline，高度 14px）。 */
function UtilSparkline(props: { history: number[] }): JSX.Element {
  const pts = props.history;
  if (!Array.isArray(pts) || pts.length < 2) return <></>;
  const w = 60;
  const h = 14;
  const points = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - Math.min(1, Math.max(0, v)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="hw-spark">
      <polyline points={points} fill="none" strokeWidth="1.2" className="hw-spark-line" />
    </svg>
  );
}

/** 历史任务：在该节点执行过（node_id 匹配）的 step 列表。 */
function nodeHistoryTasks(nodeId: string, tasks: Task[]): Array<{ task: Task; stepId: string; stepName: string; status: Task['status'] }> {
  const out: Array<{ task: Task; stepId: string; stepName: string; status: Task['status'] }> = [];
  if (!Array.isArray(tasks)) return out;
  for (const task of tasks) {
    if (!task || !Array.isArray(task.steps)) continue;
    for (const step of task.steps) {
      if (step && step.node_id === nodeId) {
        out.push({ task, stepId: step.id, stepName: step.name, status: step.status });
      }
    }
  }
  return out;
}

export function HardwareTopology(props: {
  nodes: HardwareNode[];
  tasks: Task[];
  history: Record<string, number[]>;
}): JSX.Element {
  const t = useTranslate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = (Array.isArray(props.nodes) ? props.nodes : []).filter(isNode);

  if (nodes.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state__title">{t('hw.empty.title')}</p>
        <p className="empty-state__hint">
          {t('hw.empty.hint')}
        </p>
      </div>
    );
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="hw-topo">
      {KIND_ORDER.map((kind) => {
        const group = nodes.filter((n) => n.kind === kind);
        if (group.length === 0) return null;
        const online = group.filter((n) => n.status === 'online').length;
        return (
          <section key={kind} className="hw-group" data-kind={kind}>
            <header className="hw-group__header" data-testid={`hw-group-header-${kind}`}>
              <span className={`hw-group__kind hw-group__kind--${kind}`}>
                {KIND_LABELS[kind]}
                {kind === 'qpu' ? (
                  <span className="hw-group__online mono">
                    {t('hw.group.online', { online, total: group.length })}
                  </span>
                ) : null}
              </span>
              <span className="hw-group__count mono">{group.length}</span>
            </header>
            <div className="hw-group__grid">
              {group.map((node) => {
                const leased = Array.isArray(node.allocations) ? node.allocations.length : 0;
                const capacity = Number.isFinite(node.capacity) && node.capacity > 0
                  ? Math.floor(node.capacity)
                  : 1;
                const util = Number.isFinite(node.utilization)
                  ? Math.min(1, Math.max(0, node.utilization))
                  : 0;
                const qpuM = qpuMetricsOf(node);
                const cpuM = cpuMetricsOf(node);
                const gpuM = gpuMetricsOf(node);
                const tqMedian = qpuM !== null ? medianTqFidelity(qpuM.topology.couplers) : null;
                // v1.4 来源标注：云端真机（lq-* 或无保真度）「云端 · N 比特 · 型号」，
                // simulated「模拟 · N 比特」（保真度中位保留在 Drawer 摘要）
                const cloud = isCloudQpu(node) || tqMedian === null;
                // v1.4：云端利用率 0 = 平台无数据 → "—"（不显示 0%）
                const utilNoData = isCloudQpu(node) && node.utilization === 0;
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-testid={`hw-card-${node.id}`}
                    data-utilization={String(node.utilization)}
                    className={[
                      'hw-card',
                      'card',
                      `hw-card--${node.kind}`,
                      node.status === 'offline' ? 'hw-card--offline' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setSelectedId(node.id)}
                    aria-label={t('hw.nodeAria', { name: node.name })}
                  >
                    <span className="hw-card__head">
                      <span className="hw-card__name truncate">{node.name}</span>
                      <span
                        className={`hw-card__status hw-card__status--${node.status === 'offline' ? 'offline' : 'online'}`}
                      >
                        {node.status === 'offline' ? t('hw.status.offline') : t('hw.status.online')}
                      </span>
                    </span>
                    <span className="hw-card__model mono truncate">{node.model}</span>
                    {qpuM !== null && qpuM.qubits_count > 0 ? (
                      <span className="hw-card__qpu-subline mono truncate">
                        {cloud
                          ? t('hw.qpu.sublineCloud', {
                              count: qpuM.qubits_count,
                              model: node.model,
                            })
                          : t('hw.qpu.sublineSim', { count: qpuM.qubits_count })}
                      </span>
                    ) : null}
                    <span className="hw-card__util">
                      <span className="hw-card__util-bar" aria-hidden="true">
                        <span
                          className="hw-card__util-fill"
                          style={{ width: `${util * 100}%` }}
                        />
                      </span>
                      <span className="hw-card__util-num mono">
                        {utilNoData ? '—' : formatPercent(node.utilization)}
                      </span>
                      <UtilSparkline history={props.history[node.id] ?? []} />
                    </span>
                    {cpuM !== null && Number.isFinite(cpuM.cpu_usage) && Number.isFinite(cpuM.memory_used_gb) ? (
                      <span className="hw-card__minis">
                        <MiniBar
                          label={t('hw.mini.cpu')}
                          pct={cpuM.cpu_usage}
                          value={formatPercent(cpuM.cpu_usage)}
                          variant="cpu"
                        />
                        <MiniBar
                          label={t('hw.mini.mem')}
                          pct={cpuM.memory_used_gb / Math.max(1e-9, cpuM.memory_total_gb)}
                          value={`${cpuM.memory_used_gb.toFixed(1)}/${formatGB(cpuM.memory_total_gb)}`}
                        />
                      </span>
                    ) : null}
                    {gpuM !== null && Number.isFinite(gpuM.vram_used_gb) ? (
                      <span className="hw-card__minis">
                        <MiniBar
                          label={t('hw.mini.vram')}
                          pct={gpuM.vram_used_gb / Math.max(1e-9, gpuM.vram_total_gb)}
                          value={`${gpuM.vram_used_gb.toFixed(1)}/${formatGB(gpuM.vram_total_gb)}`}
                          variant="vram"
                        />
                      </span>
                    ) : null}
                    <span
                      className="hw-card__dots"
                      aria-label={t('hw.capacity', { capacity, leased })}
                      title={t('hw.capacity', { capacity, leased })}
                    >
                      {Array.from({ length: Math.min(capacity, 16) }, (_, i) => (
                        <span
                          key={i}
                          className={`hw-card__dot ${i < leased ? 'hw-card__dot--leased' : 'hw-card__dot--free'}`}
                        />
                      ))}
                    </span>
                    {leased > 0 ? (
                      <span className="hw-card__allocs">
                        {node.allocations.map((alloc) => (
                          <span key={`${alloc.task_id}/${alloc.step_id}`} className="hw-alloc mono">
                            {alloc.agent_id} · {alloc.task_id}/{alloc.step_id}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <Drawer
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected ? t('hw.drawer.title', { name: selected.name }) : ''}
      >
        {selected ? (
          <div className="hw-detail">
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>{t('hw.detail.id')}</dt>
                <dd className="mono">{selected.id}</dd>
              </div>
              <div className="detail-list__row">
                <dt>{t('hw.detail.kind')}</dt>
                <dd className="mono">{selected.kind}</dd>
              </div>
              <div className="detail-list__row">
                <dt>{t('hw.detail.model')}</dt>
                <dd className="mono">{selected.model}</dd>
              </div>
              <div className="detail-list__row">
                <dt>{t('hw.detail.status')}</dt>
                <dd>{selected.status === 'offline' ? t('hw.status.offline') : t('hw.status.online')}</dd>
              </div>
              <div className="detail-list__row">
                <dt>{t('hw.detail.capacity')}</dt>
                <dd className="mono">
                  {selected.capacity} / {selected.allocations.length}
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>{t('hw.detail.util')}</dt>
                <dd className="mono">{formatPercent(selected.utilization)}</dd>
              </div>
              {cpuMetricsOf(selected) !== null ? (
                <>
                  <div className="detail-list__row">
                    <dt>{t('hw.detail.cpuCores')}</dt>
                    <dd className="mono">{cpuMetricsOf(selected)!.cpu_cores}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>{t('hw.detail.cpuUsage')}</dt>
                    <dd className="mono">{formatPercent(cpuMetricsOf(selected)!.cpu_usage)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>{t('hw.detail.memory')}</dt>
                    <dd className="mono">
                      {cpuMetricsOf(selected)!.memory_used_gb.toFixed(1)} /{' '}
                      {formatGB(cpuMetricsOf(selected)!.memory_total_gb)}
                    </dd>
                  </div>
                </>
              ) : null}
              {gpuMetricsOf(selected) !== null ? (
                <div className="detail-list__row">
                  <dt>{t('hw.detail.vram')}</dt>
                  <dd className="mono">
                    {gpuMetricsOf(selected)!.vram_used_gb.toFixed(1)} /{' '}
                    {formatGB(gpuMetricsOf(selected)!.vram_total_gb)}
                  </dd>
                </div>
              ) : null}
            </dl>

            {qpuMetricsOf(selected) !== null ? (
              <div className="hw-detail__topo">
                <p className="hw-detail__topo-summary mono" data-testid="hw-drawer-topo-summary">
                  {(() => {
                    const m = qpuMetricsOf(selected)!;
                    const med = medianTqFidelity(m.topology.couplers);
                    // v1.4：云端（或无保真度）→ 来源行；simulated → 保真度中位摘要
                    return isCloudQpu(selected) || med === null
                      ? t('hw.qpu.sublineCloud', {
                          count: m.qubits_count,
                          model: selected.model,
                        })
                      : t('hw.qpu.subline', {
                          count: m.qubits_count,
                          median: (med * 100).toFixed(2) + '%',
                        });
                  })()}
                </p>
                <QpuTopologyCanvas metrics={qpuMetricsOf(selected)!} />
              </div>
            ) : null}

            <h4 className="hw-detail__section">{t('hw.detail.allocs')}</h4>
            {selected.allocations.length === 0 ? (
              <p className="text-faint hw-detail__empty">{t('hw.detail.allocsEmpty')}</p>
            ) : (
              <ul className="hw-detail__allocs">
                {selected.allocations.map((a) => (
                  <li key={`${a.task_id}/${a.step_id}`} className="mono">
                    {a.agent_id} · {a.task_id}/{a.step_id}
                  </li>
                ))}
              </ul>
            )}
            <h4 className="hw-detail__section">{t('hw.detail.history')}</h4>
            {nodeHistoryTasks(selected.id, props.tasks).length === 0 ? (
              <p className="text-faint hw-detail__empty">{t('hw.detail.historyEmpty')}</p>
            ) : (
              <ul className="hw-detail__history">
                {nodeHistoryTasks(selected.id, props.tasks).map((h) => (
                  <li key={`${h.task.id}-${h.stepId}`}>
                    <span className="truncate">{h.stepName}</span>
                    <span className="mono text-faint truncate">{h.task.name} · {h.stepId}</span>
                    <StatusBadge status={h.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
