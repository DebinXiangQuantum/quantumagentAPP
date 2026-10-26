/**
 * ChatPanel.tsx —— 对话区容器（design.md §5，v1.1 增思考过程流式态）。
 *
 * 职责：
 *  - 居中流体列（max 820px）：消息流（分组规则：连续 assistant 为一组，
 *    组首带头像，角色切换处细分隔线）+ 流式消息（带闪烁光标）；
 *  - 流式期间：思考增量先于正文（契约 §7）——正文未到时显示
 *    「思考中…」微光标态；思考折叠块（ReasoningBlock）实时累加摘要；
 *    v1.4：专家工作区（SubagentWorkspace）在流式气泡与已完成气泡内嵌
 *    渐进渲染（agent.activity 聚合数据驱动）；
 *  - 新内容自动滚动到底部（用户主动上滚超过阈值时暂停跟随）；
 *  - 空态：无会话 / 无消息两种插画式文案（i18n）；
 *  - SSE error 事件 → 内联警示条（可清除；流自动重连无需手动重试）。
 * Props 契约：无 props（数据来自 useAppStore）。
 * 交互行为：输入区见 MessageInput；卡片展开见 ArtifactCard。
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import type { Message } from '../../types/domain';
import { MessageBubble } from './MessageBubble';
import { ArtifactCard } from './ArtifactCard';
import { MarkdownContent } from './MarkdownContent';
import { MessageInput } from './MessageInput';
import { StreamingCursor } from './StreamingCursor';
import { ReasoningBlock } from './ReasoningBlock';
import { SubagentWorkspace } from './SubagentWorkspace';
import { SubagentThreadDrawer } from './SubagentThreadDrawer';
import type { SubagentActivity } from '../../store/appStore';
import { MessageListSkeleton } from '../common/Skeletons';
import { useTranslate } from '../../i18n';

/** 用户上滚超过该像素值时停止自动跟随（避免打断回看）。 */
const FOLLOW_THRESHOLD_PX = 80;

/** 光标淡出驻留时长（略长于 --motion-fast，保证 120ms 过渡可见）。 */
const CURSOR_FADE_MS = 220;

export function ChatPanel(): JSX.Element {
  const t = useTranslate();
  const activeCid = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);
  const messagesByCid = useAppStore((s) => s.messagesByCid);
  const streamingByCid = useAppStore((s) => s.streamingByCid);
  const subagentActivityByMessage = useAppStore((s) => s.subagentActivityByMessage);
  const agents = useAppStore((s) => s.agents);
  const loadedCids = useAppStore((s) => s.loadedCids);
  const streamError = useAppStore((s) => s.streamError);
  const clearStreamError = useAppStore((s) => s.clearStreamError);
  const sendMessage = useAppStore((s) => s.sendMessage);

  const flowRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  // 光标完成淡出：streaming → 无 streaming 的迁移瞬间短暂渲染 fading 光标
  const [cursorFading, setCursorFading] = useState(false);
  const prevStreamingId = useRef<string | null>(null);
  useEffect(() => {
    const currentId = streamingByCid[activeCid ?? '']?.messageId ?? null;
    const wasStreaming = prevStreamingId.current !== null;
    prevStreamingId.current = currentId;
    if (wasStreaming && currentId === null) {
      setCursorFading(true);
      const timer = setTimeout(() => setCursorFading(false), CURSOR_FADE_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [streamingByCid, activeCid]);

  const conv = conversations.find((c) => c.id === activeCid) ?? null;
  const messages: Message[] = activeCid ? messagesByCid[activeCid] ?? [] : [];
  const streaming = activeCid ? streamingByCid[activeCid] : undefined;
  // v1.10 子线程抽屉状态：当前打开的 SubagentActivity（null=关闭）
  const [openThread, setOpenThread] = useState<SubagentActivity | null>(null);

  const messagesLoading =
    activeCid !== null && !loadedCids[activeCid] && !streaming;

  // v1.4 专家显示名解析（agents 注册表 → 原始 id 回退）
  const agentNameOf = (agentId: string): string =>
    agents.find((a) => a.id === agentId)?.name ?? agentId;
  const activitiesOf = (messageId: string | undefined) =>
    messageId ? subagentActivityByMessage[messageId] ?? [] : [];

  // 自动跟随：新消息/流式增量/专家工作区增量到达时滚到底（用户上滚则暂停）
  const streamedText = streaming?.text ?? '';
  const streamedReasoning = streaming?.reasoning ?? '';
  const streamingActivities = activitiesOf(streaming?.messageId);
  useEffect(() => {
    const el = flowRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamedText, streamedReasoning, streamingActivities, activeCid]);

  const handleScroll = (): void => {
    const el = flowRef.current;
    if (!el) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
  };

  return (
    <section className="chat-panel" data-testid="chat-panel" aria-label={t('chat.aria')}>
      <div className="chat-panel__inner">
        {streamError ? (
          <div className="error-bar chat-panel__error" role="alert">
            <span className="truncate">{streamError}</span>
            <button type="button" className="btn btn--sm" onClick={clearStreamError}>
              {t('chat.error.clear')}
            </button>
          </div>
        ) : null}

        <div
          className="message-flow"
          data-testid="message-flow"
          ref={flowRef}
          onScroll={handleScroll}
        >
          {activeCid === null ? (
            <div className="empty-state">
              <p className="empty-state__title">{t('chat.emptyConv.title')}</p>
              <p className="empty-state__hint">{t('chat.emptyConv.hint')}</p>
            </div>
          ) : messagesLoading ? (
            <MessageListSkeleton count={2} />
          ) : messages.length === 0 && !streaming ? (
            <div className="empty-state">
              <p className="empty-state__title">{t('chat.emptyMsg.title')}</p>
              <p className="empty-state__hint">
                {t('chat.emptyMsg.hint', {
                  // 标题为空时不拼接分隔点，避免出现「让 · Agent」的孤立点
                  scope: conv && conv.title.length > 0 ? `${conv.title} · ` : '',
                })}
              </p>
            </div>
          ) : (
            <>
              {messages.map((message, i) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  activities={activitiesOf(message.id)}
                  agentNameOf={agentNameOf}
                  showAvatar={
                    message.role === 'assistant' && messages[i - 1]?.role !== 'assistant'
                  }
                  separator={i > 0 && messages[i - 1].role !== message.role}
                />
              ))}
              {streaming ? (
                <div className="message message--assistant message--streaming">
                  <span className="message__avatar" aria-hidden="true">
                    Q
                  </span>
                  <div className="message__body">
                    {streaming.reasoning ? (
                      <ReasoningBlock
                        reasoning={streaming.reasoning}
                        active={streaming.text.length === 0}
                      />
                    ) : null}
                    {activitiesOf(streaming.messageId).map((activity) => (
                      <SubagentWorkspace
                        key={activity?.agentId ?? 'unknown'}
                        activity={activity}
                        agentName={agentNameOf(activity?.agentId ?? '')}
                        onOpenThread={() => setOpenThread(activity)}
                      />
                    ))}
                    <div className="message__text">
                      {streaming.text.length > 0 ? (
                        // v1.5：流式正文同样走 Markdown 管线；截断/未闭合语法
                        // 由 MarkdownContent 边界兜底，不得崩溃
                        <MarkdownContent content={streaming.text} />
                      ) : (
                        <span className="message__thinking">{t('reasoning.thinking')}</span>
                      )}
                      <StreamingCursor />
                    </div>
                    {(streaming.artifacts ?? []).length > 0 ? (
                      <div className="message__artifacts">
                        {(streaming.artifacts ?? []).map((artifact, i) => (
                          <ArtifactCard
                            key={typeof artifact?.id === 'string' ? artifact.id : `stream-artifact-${i}`}
                            artifact={artifact}
                            streaming
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {cursorFading && !streaming && messages.length > 0 ? (
                <div className="message-cursor-fade" aria-hidden="true">
                  <StreamingCursor fading />
                </div>
              ) : null}
            </>
          )}
        </div>

        <MessageInput
          onSend={(text, attachments) => {
            followRef.current = true;
            void sendMessage(text, {
              attachmentIds: attachments.map((a) => a.id),
              attachments,
            });
          }}
        />
      </div>
          {/* v1.10 子 Agent 完整线程抽屉（点击工作区卡片打开） */}
      <SubagentThreadDrawer
        activity={openThread}
        agentName={openThread ? agentNameOf(openThread.agentId) : ''}
        onClose={() => setOpenThread(null)}
      />
    </section>
  );
}
