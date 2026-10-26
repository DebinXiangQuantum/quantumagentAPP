/**
 * SubagentWorkspace.tsx —— 消息内嵌「专家工作区」卡片（v1.10 重写）。
 *
 * 设计（用户核心反馈：subagent 必须有清晰展示 + 点开看完整对话）：
 *  - 卡片比 v1.4 更醒目（图标 + 专家名 + 状态徽标 + 输出/工具计数）；
 *  - 流式期间展开显示实时正文 + 工具调用行 + 光标（渐进反馈）；
 *  - 完成后折叠为摘要行；**点击整卡**打开 SubagentThreadDrawer
 *    （Codex 风格完整子线程视图：思考全文/输出/工具参数/时间线）。
 * Props 契约：
 *  - activity: SubagentActivity（store 聚合形状；畸形降级不崩溃）
 *  - agentName?: string（显示名）
 *  - onOpenThread?: () => void（打开完整线程抽屉的回调；无则内联展开）
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../i18n';
import type { SubagentActivity } from '../../store/appStore';
import { StreamingCursor } from './StreamingCursor';

export function SubagentWorkspace(props: {
  activity: SubagentActivity;
  agentName?: string;
  onOpenThread?: () => void;
}): JSX.Element {
  const t = useTranslate();
  const activity = props.activity;
  const agentId = typeof activity?.agentId === 'string' ? activity.agentId : 'unknown';
  const reasoning = typeof activity?.reasoning === 'string' ? activity.reasoning : '';
  const text = typeof activity?.text === 'string' ? activity.text : '';
  const toolCalls = Array.isArray(activity?.toolCalls) ? activity.toolCalls : [];
  const running = activity?.phase !== 'dispatch_completed';
  const displayName =
    typeof props.agentName === 'string' && props.agentName.length > 0
      ? props.agentName
      : agentId;
  const hasThread = props.onOpenThread !== undefined;

  const [expanded, setExpanded] = useState(running);
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running) setExpanded(false);
    prevRunning.current = running;
  }, [running]);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && running && expanded) el.scrollTop = el.scrollHeight;
  }, [text, reasoning, running, expanded]);

  const textChars = Array.from(text).length;
  const reasoningChars = Array.from(reasoning).length;

  return (
    <div
      className={`subagent-ws${running ? ' subagent-ws--running' : ''}`}
      data-testid={`subagent-workspace-${agentId}`}
      data-running={String(running)}
      data-phase={activity?.phase ?? ''}
      aria-expanded={expanded}
    >
      {/* 头部：点击展开/收束；有 onOpenThread 时再次点击打开完整线程 */}
      <button
        type="button"
        className="subagent-ws__header"
        data-testid={`subagent-toggle-${agentId}`}
        aria-expanded={expanded}
        aria-label={t('subagent.workspaceTitle', { agent: displayName })}
        onClick={() => {
          if (!expanded) {
            setExpanded(true);
          } else if (hasThread) {
            props.onOpenThread?.();
          } else {
            setExpanded(false);
          }
        }}
      >
        <span className="subagent-ws__icon" aria-hidden="true">🔧</span>
        <span className="subagent-ws__title truncate">
          {t('subagent.workspaceTitle', { agent: displayName })}
        </span>
        {running ? (
          <span className="subagent-ws__badge" data-testid="subagent-running-badge">
            {t('subagent.running')}
          </span>
        ) : (
          <span className="subagent-ws__badge subagent-ws__badge--done" data-testid="subagent-done-badge">
            {t('subagent.completed')}
          </span>
        )}
        {/* v1.10 统计徽标：输出字数 + 工具次数 */}
        <span className="subagent-ws__stats mono" data-testid={`subagent-stats-${agentId}`}>
          {textChars > 0 ? `${textChars}${t('subagent.chars')}` : ''}
          {toolCalls.length > 0 ? ` · ${toolCalls.length}${t('subagent.tools')}` : ''}
        </span>
        <span className="subagent-ws__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {/* 展开正文：流式期间实时内容；完成后可回看 */}
      {expanded ? (
        <div className="subagent-ws__body" data-testid={`subagent-body-${agentId}`} ref={bodyRef}>
          {/* 思考过程摘要行（完整思考在 Thread Drawer） */}
          {reasoningChars > 0 ? (
            <p className="subagent-ws__reasoning-hint" data-testid={`subagent-reasoning-hint-${agentId}`}>
              🧠 {t('subagent.reasoningCount', { count: reasoningChars })}
              {hasThread ? (
                <button
                  type="button"
                  className="subagent-ws__thread-link"
                  onClick={(e) => { e.stopPropagation(); props.onOpenThread?.(); }}
                  data-testid={`subagent-open-thread-${agentId}`}
                >
                  {t('subagent.viewFull')} →
                </button>
              ) : null}
            </p>
          ) : null}

          {/* 流式正文 */}
          {text.length > 0 ? (
            <p className="subagent-ws__text" data-testid={`subagent-text-${agentId}`}>
              {text}
              {running ? <StreamingCursor /> : null}
            </p>
          ) : running ? (
            <p className="subagent-ws__waiting" data-testid={`subagent-waiting-${agentId}`}>
              <StreamingCursor /> {t('subagent.working')}
            </p>
          ) : null}

          {/* 工具调用行（名称列表；参数详情在 Thread Drawer） */}
          {toolCalls.length > 0 ? (
            <div className="subagent-ws__tools" data-testid={`subagent-tools-${agentId}`}>
              {toolCalls.map((call, i) => (
                <p key={`tc-${i}`} className="subagent-ws__tool-line mono" data-testid={`subagent-tool-line-${i}`}>
                  → {t('subagent.toolCalled', { name: call.name ?? 'unknown' })}
                </p>
              ))}
            </div>
          ) : null}

          {/* 完整线程入口按钮（v1.10 核心交互） */}
          {hasThread ? (
            <button
              type="button"
              className="subagent-ws__thread-btn"
              onClick={(e) => { e.stopPropagation(); props.onOpenThread?.(); }}
              data-testid={`subagent-thread-btn-${agentId}`}
            >
              📋 {t('subagent.openFullThread')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
