/**
 * SubagentThreadDrawer.tsx —— 子 Agent 完整运行对话抽屉（v1.10，用户核心反馈）。
 *
 * 设计（Codex / Claude Code 风格子线程视图）：
 *  - 用户点击消息里的专家工作区卡片 → 右侧滑入本抽屉；
 *  - 完整呈现子 Agent 的执行轨迹：思考过程（全文 + 可折叠）、正文输出、
 *    每次工具调用（名称 + 完整参数 JSON + 结果摘要）、时间线节点；
 *  - 与父消息共享同一 Drawer 基础组件（common/Drawer），视觉一致性。
 *
 * Props 契约：
 *  - activity: SubagentActivity | null——null 不渲染（关闭态）
 *  - agentName: string——显示名（侧栏 agents 注册表解析后的中文名）
 *  - onClose: () => void——关闭回调
 * 失败行为：畸形 activity 降级为空态卡片，不崩溃。
 */
import { useState } from 'react';
import { useTranslate } from '../../i18n';
import { Drawer } from '../common/Drawer';
import { StatusBadge } from '../common/StatusBadge';
import { formatClock } from '../../utils/format';
import type { SubagentActivity, SubagentToolCall } from '../../store/appStore';

/** 单条工具调用行（名称 + 可展开的完整参数 JSON） */
function ToolCallItem(props: { call: SubagentToolCall; index: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const name = props.call?.name ?? 'unknown';
  const args = props.call?.arguments ?? '';
  // 截断预览（完整内容展开后可见）
  const preview = args.length > 120 ? `${args.slice(0, 120)}…` : args;
  return (
    <div className="subagent-thread__tool" data-testid={`subagent-tool-${props.index}`}>
      <button
        type="button"
        className="subagent-thread__tool-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="mono subagent-thread__tool-index">#{props.index + 1}</span>
        <span className="subagent-thread__tool-name mono truncate">{name}</span>
        <span className="subagent-thread__tool-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <pre className="subagent-thread__tool-args mono" data-testid={`subagent-tool-args-${props.index}`}>
          {args || '（无参数）'}
        </pre>
      ) : (
        <p className="subagent-thread__tool-preview mono truncate">{preview}</p>
      )}
    </div>
  );
}

/** 时间线节点行 */
function TimelineItem(props: {
  phase: string;
  at: string;
  summary?: string;
}): JSX.Element {
  const isStart = props.phase === 'dispatch_started';
  const isDone = props.phase === 'dispatch_completed';
  return (
    <div className="subagent-thread__timeline-item" data-testid="subagent-timeline-item">
      <span
        className={`subagent-thread__timeline-dot${
          isStart ? ' subagent-thread__timeline-dot--start' : isDone ? ' subagent-thread__timeline-dot--done' : ''
        }`}
        aria-hidden="true"
      />
      <span className="subagent-thread__timeline-phase mono">{props.phase}</span>
      {props.summary ? (
        <span className="subagent-thread__timeline-summary truncate">{props.summary}</span>
      ) : null}
      <span className="subagent-thread__timeline-time mono">{formatClock(props.at)}</span>
    </div>
  );
}

export function SubagentThreadDrawer(props: {
  activity: SubagentActivity | null;
  agentName: string;
  onClose: () => void;
}): JSX.Element {
  const t = useTranslate();
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const a = props.activity;
  if (a === null) return <></>;

  const running = a.phase !== 'dispatch_completed';
  const displayName = props.agentName || a.agentId;
  const reasoningLen = (a.reasoning ?? '').length;
  const textLen = (a.text ?? '').length;
  const tools = Array.isArray(a.toolCalls) ? a.toolCalls : [];
  const timeline = Array.isArray(a.timeline) ? a.timeline : [];

  return (
    <Drawer
      open={a !== null}
      onClose={props.onClose}
      title={`${displayName} · ${running ? t('subagent.running') : t('subagent.completed')}`}
    >
      <div className="subagent-thread" data-testid="subagent-thread-drawer">
        {/* 概要头部：专家名 / 状态 / 输出统计 */}
        <div className="subagent-thread__summary">
          <StatusBadge status={running ? 'running' : 'succeeded'} />
          <span className="subagent-thread__stats mono" data-testid="subagent-thread-stats">
            {t('subagent.stats', {
              reasoning: reasoningLen,
              text: textLen,
              tools: tools.length,
            })}
          </span>
        </div>

        {/* 思考过程（全文，可折叠） */}
        {reasoningLen > 0 ? (
          <section className="subagent-thread__section">
            <button
              type="button"
              className="subagent-thread__section-header"
              onClick={() => setShowReasoning((v) => !v)}
              aria-expanded={showReasoning}
              data-testid="subagent-thread-reasoning-toggle"
            >
              <span>🧠 {t('subagent.reasoning')}</span>
              <span className="mono">{reasoningLen} 字</span>
            </button>
            {showReasoning ? (
              <div
                className="subagent-thread__reasoning-body mono"
                data-testid="subagent-thread-reasoning-body"
              >
                {a.reasoning}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* 正文输出（全文展示） */}
        {textLen > 0 ? (
          <section className="subagent-thread__section">
            <div className="subagent-thread__section-header subagent-thread__section-header--static">
              <span>💬 {t('subagent.output')}</span>
              <span className="mono">{textLen} 字</span>
            </div>
            <div className="subagent-thread__text-body" data-testid="subagent-thread-text">
              {a.text}
            </div>
          </section>
        ) : null}

        {/* 工具调用列表（每次调用：名称 + 展开看完整参数） */}
        {tools.length > 0 ? (
          <section className="subagent-thread__section">
            <div className="subagent-thread__section-header subagent-thread__section-header--static">
              <span>🔧 {t('subagent.toolCalls')}</span>
              <span className="mono">{tools.length}</span>
            </div>
            <div className="subagent-thread__tools" data-testid="subagent-thread-tools">
              {tools.map((call, i) => (
                <ToolCallItem key={`tool-${i}`} call={call} index={i} />
              ))}
            </div>
          </section>
        ) : null}

        {/* 时间线（可折叠） */}
        {timeline.length > 0 ? (
          <section className="subagent-thread__section">
            <button
              type="button"
              className="subagent-thread__section-header"
              onClick={() => setShowTimeline((v) => !v)}
              aria-expanded={showTimeline}
              data-testid="subagent-thread-timeline-toggle"
            >
              <span>⏱ {t('subagent.timeline')}</span>
              <span className="mono">{timeline.length}</span>
            </button>
            {showTimeline ? (
              <div className="subagent-thread__timeline" data-testid="subagent-thread-timeline">
                {timeline.map((item, i) => (
                  <TimelineItem key={`tl-${i}`} {...item} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* 空态（尚无任何活动数据） */}
        {reasoningLen === 0 && textLen === 0 && tools.length === 0 ? (
          <p className="viz-note" data-testid="subagent-thread-empty">
            {t('subagent.empty')}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
