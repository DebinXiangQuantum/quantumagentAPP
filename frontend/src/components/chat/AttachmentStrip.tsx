/**
 * AttachmentStrip.tsx —— 附件条（design.md §5.2 v1.3，两处复用）。
 *
 * 职责：
 *  - composer 预览条与用户消息气泡内嵌附件条共用同一渲染：
 *    image → 缩略图（img src 来自预览 URL / attachmentRawUrl）；
 *    text/file → 文件卡（名称 title=完整文件名 + formatBytes 大小）；
 *  - onRemove 提供时渲染 × 移除按钮（composer）；消息气泡只读不传。
 * Props 契约：
 *  - items：AttachmentMeta[]（畸形元素丢弃）；
 *  - imageUrls：Record<id, string>（图片 src；缺省的 image 项降级为文件卡）；
 *  - onRemove?：(id) => void。
 * 失败行为：空数组 → 不渲染；防御式，不崩溃。
 */
import { useTranslate } from '../../i18n';
import { formatBytes } from '../../utils/format';
import type { AttachmentMeta } from '../../types/domain';

function isMeta(v: unknown): v is AttachmentMeta {
  return v !== null && typeof v === 'object' && typeof (v as AttachmentMeta).id === 'string';
}

export function AttachmentStrip(props: {
  items: AttachmentMeta[];
  imageUrls?: Record<string, string>;
  onRemove?: (id: string) => void;
}): JSX.Element | null {
  const t = useTranslate();
  const items = (Array.isArray(props.items) ? props.items : []).filter(isMeta);
  if (items.length === 0) return null;

  return (
    <div className="attachment-strip">
      {items.map((att) => {
        const url =
          att.kind === 'image' ? props.imageUrls?.[att.id] ?? null : null;
        return (
          <span
            key={att.id}
            data-testid={`attachment-${att.id}`}
            className={`attachment-chip${url ? ' attachment-chip--image' : ' attachment-chip--file'}`}
            title={att.name}
          >
            {url ? (
              <img
                className="attachment-chip__thumb"
                src={url}
                alt={t('attachment.imageAlt', { name: att.name })}
                loading="lazy"
              />
            ) : (
              <>
                <span className="attachment-chip__icon" aria-hidden="true">
                  {att.kind === 'text' ? '≡' : '🗎'}
                </span>
                <span className="attachment-chip__meta">
                  <span className="attachment-chip__name truncate">{att.name}</span>
                  <span className="attachment-chip__size mono">{formatBytes(att.size)}</span>
                </span>
              </>
            )}
            {props.onRemove ? (
              <button
                type="button"
                className="attachment-chip__remove"
                data-testid={`attachment-remove-${att.id}`}
                onClick={() => props.onRemove?.(att.id)}
                aria-label={t('attachment.remove', { name: att.name })}
              >
                ×
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
