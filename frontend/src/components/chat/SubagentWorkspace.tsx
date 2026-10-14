/**
 * SubagentWorkspace.tsx —— 「🔧 专家 <id> 工作区」渐进块（design.md §5 v1.4）。
 *
 * 职责（agent.activity 事件驱动，数据来自 store.subagentActivityByMessage）：
 *  - dispatch_started → 头部（专家名 + 运行中呼吸徽标）；
 *  - reasoning_delta / text_delta → 正文流式追加（caption/secondary/mono，
 *    max-height 180px 自动滚底，尾部流式光标）；
 *  - tool_call → 「→ 调用工具 <name>」行（按调用顺序，计数可断言）；
 *  - dispatch_completed → **自动折叠**为摘要行（「专家已完成 · 输出 N 字 ·
 *    工具 M 次」），点击头部可展开回看全程（text/tools 保留）；
 *  - 运行中默认展开（useState 初始 = running；完成迁移经 useEffect 收起）。
 * Props 契约：
 *  - activity: SubagentActivity（store 聚合形状；畸形按空串/空数组降级）；
 *  - agentName?: string（显示名；缺省回退原始 agent_id）。
 * 失败行为：任何畸形输入只渲染头部，不崩溃。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../i18n';
import type { SubagentActivity } from '../../store/appStore';
import { StreamingCursor } from './StreamingCursor';

export function SubagentWorkspace(props: {
  activity: SubagentActivity;
  agentName?: string;
}): JSX.Element {
  const t = useTranslate();
  const activity = props.activity;
  const agentId = typeof activity?.agentId === 'string' ? activity.agentId : 'unknown';
  const text = typeof activity?.text === 'string' ? activity.text : '';
  const tools = Array.isArray(activity?.tools) ? activity.tools : [];
  const running = activity?.phase !== 'dispatch_completed';
  const displayName =
    typeof props.agentName === 'string' && props.agentName.length > 0
      ? props.agentName
      : agentId;

  // 运行中默认展开；完成（running → false）自动折叠为摘要行
  const [expanded, setExpanded] = useState(running);
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running) setExpanded(false);
    prevRunning.current = running;
  }, [running]);

  // 流式期间自动滚底（180px 限高内跟随最新增量）
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && running && expanded) el.scrollTop = el.scrollHeight;
  }, [text, running, expanded]);

  const chars = Array.from(text).length;

  return (
    <div
      className={`subagent-ws${running ? ' subagent-ws--running' : ''}`}
      data-testid={`subagent-workspace-${agentId}`}
      data-running={String(running)}
      data-phase={activity?.phase ?? ''}
      aria-expanded={expanded}
    >
      <button
        type="button"
        className="subagent-ws__header"
        data-testid={`subagent-toggle-${agentId}`}
        aria-expanded={expanded}
        aria-label={t('subagent.toggle', { agent: displayName })}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="subagent-ws__icon" aria-hidden="true">
          🔧
        </span>
        <span className="subagent-ws__title truncate">
          {t('subagent.workspaceTitle', { agent: displayName })}
        </span>
        {running ? (
          <span className="subagent-ws__badge" data-testid="subagent-running-badge">
            {t('subagent.running')}
          </span>
        ) : (
          <span className="subagent-ws__summary mono truncate">
            {t('subagent.done', { chars, tools: tools.length })}
          </span>
        )}
        <span
          className={`subagent-ws__chevron${expanded ? ' subagent-ws__chevron--open' : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>
      {expanded ? (
        <div className="subagent-ws__body fade-in" ref={bodyRef}>
          {text.length > 0 ? (
            <pre className="subagent-ws__text mono">
              {text}
              {running ? <StreamingCursor /> : null}
            </pre>
          ) : null}
          {tools.length > 0 ? (
            <div className="subagent-ws__tools">
              {tools.map((tool, i) => (
                <span key={`${tool}-${i}`} className="subagent-ws__tool mono" data-testid={`subagent-tool-${i}`}>
                  {t('subagent.toolCall', {
                    name: typeof tool === 'string' && tool.length > 0 ? tool : '—',
                  })}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
