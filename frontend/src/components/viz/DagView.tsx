/**
 * DagView.tsx —— 任务 DAG 视图（design.md §6.3）。
 *
 * 职责：
 *  - 节点 = Step：kind 色（quantum=violet/classical=info/agent=warning 左色条）+
 *    统一 StatusBadge + 等宽 id；
 *  - 边 = 依赖（SVG 贝塞尔 + 箭头，utils/dag 生成）；
 *  - 运行中节点呼吸光晕（CSS 2s；reduced-motion 降级实线描边）；
 *  - 点击节点 → 右侧 Drawer 详情（node_id、起止时间、detail/error）；
 *  - 环/未知依赖/畸形任务防御式降级（invalid 提示），不崩溃。
 * Props 契约：{ task: Task | null }——steps 空或畸形 → 空态文案。
 */
import { useMemo, useState } from 'react';
import { buildDagModel } from '../../utils/dag';
import { StatusBadge } from '../common/StatusBadge';
import { Drawer } from '../common/Drawer';
import { formatClock } from '../../utils/format';
import type { Step, Task } from '../../types/domain';

// 布局几何（px；§6.3 修订：**纵向流水线**——依赖层自上而下堆叠、同层并排，
// 适配 360px 检查器宽度。横向布局在窄面板上会溢出到 744px 且画布高度塌缩）
const NODE_W = 200;
const NODE_H = 64;
const GAP_X = 16;
const GAP_Y = 24;
/** 画布在内容尺寸外的余量（px），保证边缘节点/箭头不被裁切 */
const CANVAS_MARGIN = 8;

export function DagView(props: { task: Task | null }): JSX.Element {
  const [selected, setSelected] = useState<Step | null>(null);
  const task = props.task;

  const model = useMemo(
    () => buildDagModel(task !== null && typeof task === 'object' ? task.steps : null),
    [task],
  );

  if (!task || typeof task !== 'object' || model.nodes.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state__title">暂无任务</p>
        <p className="empty-state__hint">
          发送一条消息让 Agent 提交 DAG，状态迁移将实时出现在这里。
        </p>
      </div>
    );
  }

  // 纵向：宽度 = 最宽层的并排节点数；高度 = 依赖层数堆叠
  const maxInLayer = Math.max(...model.nodes.map((n) => n.indexInLayer + 1));
  const width = maxInLayer * NODE_W + (maxInLayer - 1) * GAP_X;
  const height = model.layers * NODE_H + (model.layers - 1) * GAP_Y;

  const xOf = (idx: number): number => idx * (NODE_W + GAP_X);
  const yOf = (layer: number): number => layer * (NODE_H + GAP_Y);

  const nodePos = new Map(
    model.nodes.map((n) => [n.step.id, { x: xOf(n.indexInLayer), y: yOf(n.layer) }]),
  );

  return (
    <div className="dag-view">
      <div className="dag-view__header">
        <span className="dag-view__task-name truncate">{task.name}</span>
        <StatusBadge status={task.status} />
      </div>
      {model.invalid ? (
        <p className="viz-note viz-note--error" role="note">
          依赖存在环或异常，已按出现顺序降级布局。
        </p>
      ) : null}
      {/* 画布显式给内容尺寸：绝对定位的节点/SVG 不贡献流内高度，否则容器塌缩 */}
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
            // 纵向依赖边：从上层节点底边中点 → 下层节点顶边中点
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
            aria-label={`步骤 ${step.name}（${step.id}）`}
          >
            <span className="dag-node__name truncate">{step.name}</span>
            <span className="dag-node__meta mono truncate">{step.id}{step.node_id ? ` · ${step.node_id}` : ''}</span>
            <StatusBadge status={step.status} />
          </button>
        ))}
      </div>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `步骤 ${selected.id}` : ''}
      >
        {selected ? (
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>状态</dt>
              <dd><StatusBadge status={selected.status} /></dd>
            </div>
            <div className="detail-list__row">
              <dt>类型</dt>
              <dd className="mono">{selected.kind}</dd>
            </div>
            <div className="detail-list__row">
              <dt>节点</dt>
              <dd className="mono">{selected.node_id ?? '（未调度）'}</dd>
            </div>
            <div className="detail-list__row">
              <dt>开始</dt>
              <dd className="mono">{formatClock(selected.started_at)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>结束</dt>
              <dd className="mono">{formatClock(selected.finished_at)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>说明</dt>
              <dd>{selected.detail || '（无）'}</dd>
            </div>
            {selected.error ? (
              <div className="detail-list__row detail-list__row--error">
                <dt>错误</dt>
                <dd>{selected.error}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Drawer>
    </div>
  );
}
