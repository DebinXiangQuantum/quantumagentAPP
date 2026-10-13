/**
 * MessageBubble.tsx —— 单条消息气泡（design.md §5）。
 *
 * 职责：
 *  - 用户：右对齐、--bg-elevated 底色圆角气泡；
 *  - 助手：左对齐、无底色，组首条带头像（Q 标识），正文 pre-wrap；
 *  - 助手 artifacts：通栏卡片列表（ArtifactCard）。
 * Props 契约：
 *  - message：Message 契约（畸形字段按空串/空数组降级，不崩溃）；
 *  - showAvatar：助手组首条为 true；
 *  - separator：角色组切换处为 true（渲染细分隔线）。
 */
import type { Message } from '../../types/domain';
import { ArtifactCard } from './ArtifactCard';

export function MessageBubble(props: {
  message: Message;
  showAvatar?: boolean;
  separator?: boolean;
}): JSX.Element {
  const { message, showAvatar = false, separator = false } = props;
  const content = typeof message.content === 'string' ? message.content : '';
  const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];

  if (message.role === 'user') {
    return (
      <>
        {separator ? <div className="message-group-sep" role="separator" /> : null}
        <div className="message message--user">
          <div className="message__bubble">{content}</div>
        </div>
      </>
    );
  }

  return (
    <>
      {separator ? <div className="message-group-sep" role="separator" /> : null}
      <div className="message message--assistant">
        {showAvatar ? (
          <span className="message__avatar" aria-hidden="true">
            Q
          </span>
        ) : (
          <span className="message__avatar message__avatar--ghost" aria-hidden="true" />
        )}
        <div className="message__body">
          <div className="message__text">{content}</div>
          {artifacts.length > 0 ? (
            <div className="message__artifacts">
              {artifacts.map((artifact, i) => (
                <ArtifactCard
                  key={typeof artifact?.id === 'string' ? artifact.id : `artifact-${i}`}
                  artifact={artifact}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
