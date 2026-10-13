/**
 * Skeletons.tsx —— 同构骨架屏（design.md §7：shimmer 1.2s，结构与真实内容同构）。
 *
 * 职责：loading 态占位——会话项 / 消息（用户气泡+助手块）/ 硬件卡片 / DAG 节点。
 * Props 契约：{ count?: number }（缺省 1；畸形值按 1）。
 * 交互行为：无（纯占位，aria-busy 由容器标注）。
 */

/** 会话列表项骨架：标题行 + meta 行。 */
export function ConversationSkeleton(): JSX.Element {
  return (
    <div className="conversation-skeleton" aria-hidden="true">
      <div className="skeleton conversation-skeleton__title" />
      <div className="skeleton conversation-skeleton__meta" />
    </div>
  );
}

/** 会话骨架列表。 */
export function ConversationListSkeleton(props: { count?: number }): JSX.Element {
  const n =
    typeof props.count === 'number' && Number.isFinite(props.count) && props.count > 0
      ? Math.min(Math.floor(props.count), 12)
      : 1;
  return (
    <div aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <ConversationSkeleton key={i} />
      ))}
    </div>
  );
}

/** 消息骨架：助手块（头像+两行文本）与用户气泡交替。 */
export function MessageSkeleton(): JSX.Element {
  return (
    <div className="message-skeleton" aria-hidden="true">
      <div className="message-skeleton__assistant">
        <div className="skeleton message-skeleton__avatar" />
        <div className="message-skeleton__lines">
          <div className="skeleton message-skeleton__line" />
          <div className="skeleton message-skeleton__line message-skeleton__line--short" />
        </div>
      </div>
      <div className="message-skeleton__user">
        <div className="skeleton message-skeleton__bubble" />
      </div>
    </div>
  );
}

/** 消息骨架组。 */
export function MessageListSkeleton(props: { count?: number }): JSX.Element {
  const n =
    typeof props.count === 'number' && Number.isFinite(props.count) && props.count > 0
      ? Math.min(Math.floor(props.count), 10)
      : 1;
  return (
    <div className="message-list-skeleton" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <MessageSkeleton key={i} />
      ))}
    </div>
  );
}

/** 硬件卡片骨架：名称行 + 型号行 + 利用率条 + 容量点。 */
export function HwCardSkeleton(): JSX.Element {
  return (
    <div className="hw-card-skeleton" aria-hidden="true">
      <div className="skeleton hw-card-skeleton__name" />
      <div className="skeleton hw-card-skeleton__model" />
      <div className="skeleton hw-card-skeleton__bar" />
      <div className="hw-card-skeleton__dots">
        <div className="skeleton hw-card-skeleton__dot" />
        <div className="skeleton hw-card-skeleton__dot" />
      </div>
    </div>
  );
}

/** 硬件卡片骨架网格。 */
export function HwGridSkeleton(props: { count?: number }): JSX.Element {
  const n =
    typeof props.count === 'number' && Number.isFinite(props.count) && props.count > 0
      ? Math.min(Math.floor(props.count), 12)
      : 1;
  return (
    <div className="hw-grid-skeleton" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <HwCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** DAG 节点骨架。 */
export function DagSkeleton(): JSX.Element {
  return (
    <div className="dag-skeleton" aria-busy="true" aria-hidden="true">
      <div className="skeleton dag-skeleton__node" />
      <div className="skeleton dag-skeleton__node dag-skeleton__node--child" />
      <div className="skeleton dag-skeleton__node dag-skeleton__node--child2" />
    </div>
  );
}
