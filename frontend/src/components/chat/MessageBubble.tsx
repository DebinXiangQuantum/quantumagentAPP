/**
 * MessageBubble.tsx —— 单条消息气泡（design.md §5，v1.1 增思考过程）。
 *
 * 职责：
 *  - 用户：右对齐、--bg-elevated 底色圆角气泡；§5.2 v1.3 附件条内嵌气泡
 *    （复用 AttachmentStrip：image 缩略图 / 文件卡，只读无移除）；
 *  - 助手：左对齐、无底色，组首条带头像（Q 标识），正文 pre-wrap；
 *    消息顶部渲染「思考过程」折叠块（message.reasoning 非空时，见
 *    ReasoningBlock——默认收起、摘要 + chevron、展开 240px 滚动）；
 *  - 时间戳：HH:MM（等宽、faint），随气泡对齐（视觉评审补充：会话流
 *    缺乏时间锚点会显得"漂浮"）；
 *  - 助手 artifacts：通栏卡片列表（ArtifactCard）。
 * Props 契约：
 *  - message：Message 契约（畸形字段按空串/空数组降级，不崩溃）；
 *  - showAvatar：助手组首条为 true；
 *  - separator：角色组切换处为 true（渲染细分隔线）。
 */
import type { Message } from '../../types/domain';
import { formatHM } from '../../utils/format';
import { getApi } from '../../api';
import { ArtifactCard } from './ArtifactCard';
import { AttachmentStrip } from './AttachmentStrip';
import { ReasoningBlock } from './ReasoningBlock';

/** 附件只读渲染的 image src 集合（image → attachmentRawUrl；其余走文件卡）。 */
function imageUrlsOf(attachments: Message['attachments']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const att of attachments ?? []) {
    if (att && att.kind === 'image') out[att.id] = getApi().attachmentRawUrl(att.id);
  }
  return out;
}

export function MessageBubble(props: {
  message: Message;
  showAvatar?: boolean;
  separator?: boolean;
}): JSX.Element {
  const { message, showAvatar = false, separator = false } = props;
  const content = typeof message.content === 'string' ? message.content : '';
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
  const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  // 畸形 created_at → '—'，时间戳仍占位保持行距稳定（防御式，不崩溃）
  const time = formatHM(message.created_at);

  if (message.role === 'user') {
    return (
      <>
        {separator ? <div className="message-group-sep" role="separator" /> : null}
        <div className="message message--user">
          <div className="message__stack">
            <div className="message__bubble">
              {attachments.length > 0 ? (
                <AttachmentStrip items={attachments} imageUrls={imageUrlsOf(attachments)} />
              ) : null}
              {content}
            </div>
            <time className="message__time mono" dateTime={message.created_at || undefined}>
              {time}
            </time>
          </div>
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
          {reasoning.length > 0 ? <ReasoningBlock reasoning={reasoning} /> : null}
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
          <time className="message__time message__time--assistant mono" dateTime={message.created_at || undefined}>
            {time}
          </time>
        </div>
      </div>
    </>
  );
}
