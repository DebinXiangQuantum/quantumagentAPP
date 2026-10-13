/**
 * ReasoningBlock.tsx —— 助手消息顶部「思考过程」折叠块（design.md §5 v1.1）。
 *
 * 职责：
 *  - 默认收起：一行摘要（标题 + 字数 + chevron 旋转 affordance）；
 *  - 展开：mono / caption 字号 / --text-secondary / max-height 240px 内滚动；
 *  - 流式期间（active=true）：摘要显示「思考中…」，正文流式追加微光标；
 *  - reasoning 为空且非 active → 不渲染（用户消息/无思考消息零开销）。
 * Props 契约：
 *  - reasoning: string（畸形按 '' 降级）；
 *  - active?: boolean（思考流进行中；缺省 false）。
 * 失败行为：任何畸形输入降级为空串/不渲染，不崩溃。
 */
import { useState } from 'react';
import { useTranslate } from '../../i18n';
import { StreamingCursor } from './StreamingCursor';

export function ReasoningBlock(props: {
  reasoning: string;
  active?: boolean;
}): JSX.Element | null {
  const t = useTranslate();
  const [expanded, setExpanded] = useState(false);
  const reasoning = typeof props.reasoning === 'string' ? props.reasoning : '';
  const active = props.active === true;
  if (reasoning.length === 0 && !active) return null;

  const chars = Array.from(reasoning).length;
  // 流式期间摘要显示「思考中…」，完成后显示字数
  const summary = active ? t('reasoning.thinking') : t('reasoning.chars', { n: chars });

  return (
    <div className="reasoning" data-testid="reasoning-block" data-active={String(active)}>
      <button
        type="button"
        className="reasoning__header"
        aria-expanded={expanded}
        aria-label={t('reasoning.toggle')}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="reasoning__icon" aria-hidden="true">
          🧠
        </span>
        <span className="reasoning__title">{t('reasoning.title')}</span>
        <span className="reasoning__summary mono">{summary}</span>
        <span
          className={`reasoning__chevron${expanded ? ' reasoning__chevron--open' : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>
      {expanded ? (
        <div className="reasoning__body fade-in">
          <pre className="reasoning__text mono">
            {reasoning}
            {active ? <StreamingCursor /> : null}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
