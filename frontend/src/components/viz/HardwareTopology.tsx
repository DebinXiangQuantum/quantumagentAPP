/**
 * HardwareTopology.tsx —— 异构硬件拓扑视图（design.md §6.4）。
 *
 * 职责：
 *  - 按 kind 分组（QPU/GPU/CPU）的卡片网格；
 *  - 卡片：型号（等宽）、容量点（活动租约实心）、利用率迷你条（60s 滚动历史
 *    sparkline + 当前值）、活动 allocation 徽标（"agent · task/step"）；
 *  - 点击卡片 → Drawer：节点全量信息 + 该节点历史任务；
 *  - offline 节点：降饱和 + 斜纹（CSS）。
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
import type { HardwareNode, NodeKind, Task } from '../../types/domain';

const KIND_ORDER: NodeKind[] = ['qpu', 'gpu', 'cpu'];
const KIND_LABELS: Record<NodeKind, string> = { qpu: 'QPU', gpu: 'GPU', cpu: 'CPU' };

function isNode(v: unknown): v is HardwareNode {
  return v !== null && typeof v === 'object' && typeof (v as HardwareNode).id === 'string';
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
        return (
          <section key={kind} className="hw-group" data-kind={kind}>
            <header className="hw-group__header">
              <span className={`hw-group__kind hw-group__kind--${kind}`}>
                {KIND_LABELS[kind]}
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
                    <span className="hw-card__util">
                      <span className="hw-card__util-bar" aria-hidden="true">
                        <span
                          className="hw-card__util-fill"
                          style={{ width: `${util * 100}%` }}
                        />
                      </span>
                      <span className="hw-card__util-num mono">{formatPercent(node.utilization)}</span>
                      <UtilSparkline history={props.history[node.id] ?? []} />
                    </span>
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
            </dl>
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
