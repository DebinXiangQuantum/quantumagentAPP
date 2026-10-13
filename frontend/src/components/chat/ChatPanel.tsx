/**
 * ChatPanel.tsx —— 对话区容器（design.md §5）。
 *
 * 职责：
 *  - 居中流体列（max 820px）：消息流（分组规则：连续 assistant 为一组，
 *    组首带头像，角色切换处细分隔线）+ 流式消息（带闪烁光标）；
 *  - 新内容自动滚动到底部（用户主动上滚超过阈值时暂停跟随）；
 *  - 空态：无会话 / 无消息两种插画式文案；
 *  - SSE error 事件 → 内联警示条（可清除；流自动重连无需手动重试）。
 * Props 契约：无 props（数据来自 useAppStore）。
 * 交互行为：输入区见 MessageInput；卡片展开见 ArtifactCard。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import type { Message } from '../../types/domain';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { StreamingCursor } from './StreamingCursor';

/** 用户上滚超过该像素值时停止自动跟随（避免打断回看）。 */
const FOLLOW_THRESHOLD_PX = 80;

export function ChatPanel(): JSX.Element {
  const activeCid = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);
  const messagesByCid = useAppStore((s) => s.messagesByCid);
  const streamingByCid = useAppStore((s) => s.streamingByCid);
  const streamError = useAppStore((s) => s.streamError);
  const clearStreamError = useAppStore((s) => s.clearStreamError);
  const sendMessage = useAppStore((s) => s.sendMessage);

  const flowRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  const conv = conversations.find((c) => c.id === activeCid) ?? null;
  const messages: Message[] = activeCid ? messagesByCid[activeCid] ?? [] : [];
  const streaming = activeCid ? streamingByCid[activeCid] : undefined;

  // 自动跟随：新消息/流式增量到达时滚到底（用户上滚则暂停）
  useEffect(() => {
    const el = flowRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming?.text, activeCid]);

  const handleScroll = (): void => {
    const el = flowRef.current;
    if (!el) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
  };

  return (
    <section className="chat-panel" data-testid="chat-panel" aria-label="对话区">
      <div className="chat-panel__inner">
        {streamError ? (
          <div className="error-bar chat-panel__error" role="alert">
            <span className="truncate">{streamError}</span>
            <button type="button" className="btn btn--sm" onClick={clearStreamError}>
              清除
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
              <p className="empty-state__title">暂无会话</p>
              <p className="empty-state__hint">
                在左侧新建一个会话，或等待数据加载完成。
              </p>
            </div>
          ) : messages.length === 0 && !streaming ? (
            <div className="empty-state">
              <p className="empty-state__title">对话尚未开始</p>
              <p className="empty-state__hint">
                发送第一条消息，让 {conv ? `${conv.title} · ` : ''}Agent 开始工作。
              </p>
            </div>
          ) : (
            <>
              {messages.map((message, i) => (
                <MessageBubble
                  key={message.id}
                  message={message}
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
                    <div className="message__text">
                      {streaming.text}
                      <StreamingCursor />
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <MessageInput
          onSend={(text) => {
            followRef.current = true;
            void sendMessage(text);
          }}
        />
      </div>
    </section>
  );
}
