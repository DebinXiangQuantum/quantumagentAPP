/**
 * MessageInput.tsx —— v1.3 composer（design.md §5 输入区工具条 + §5.2 附件）。
 *
 * 结构（对齐主流 Agent 对话页形态）：
 *  - 多行文本输入（Enter 发送 / Shift+Enter 换行，自适应增高 cap 8 行）；
 *  - 附件预览条（缩略图/文件卡 ×，可移除——AttachmentStrip 复用）；
 *  - 底部工具条：左 ＋附件（file input：image/* + 任意）；中 模型▾ 思考▾
 *    （v1.2 从顶栏迁入；切模型思考跟随渠道 default_thinking，联动在 store）；
 *    右 发送（发送中态/失败内联重试来自 store）。
 * Props 契约：{ onSend: (text, attachments) => void }——发送与附件上传
 *  的网络路径经 store/api，便于注入测试。
 * 失败行为：附件上传失败 → 内联错误条；发送失败 → store.sendError 内联
 *  + 重试按钮（retrySend 重发 failedDraft——草稿保留在 store，输入框已清空）。
 */
import { useRef, useState } from 'react';
import { TOKENS } from '../../styles/tokens';
import { useTranslate } from '../../i18n';
import { getApi } from '../../api';
import { useAppStore } from '../../store/appStore';
import { THINKING_LEVELS, parseThinkingLevel } from '../../types/domain';
import type { AttachmentMeta } from '../../types/domain';
import { AttachmentStrip } from './AttachmentStrip';

const MAX_INPUT_ROWS = 8;
/** 单行高度 = fs-body × lh-body（token 派生，避免硬编码行高）。 */
const ROW_HEIGHT_PX =
  parseFloat(TOKENS.fontSize.body) * parseFloat(TOKENS.lineHeight.body);

/** 预览条条目：服务端元数据 + 本地 objectURL（图片缩略图，发送前有效）。 */
interface PendingAttachment extends AttachmentMeta {
  localUrl?: string;
}

export function MessageInput(props: {
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
}): JSX.Element {
  const t = useTranslate();
  const [value, setValue] = useState('');
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 工具条选择器（v1.2 迁入）与发送中态（v1.2）
  const modelChannels = useAppStore((s) => s.modelChannels);
  const currentModelRef = useAppStore((s) => s.currentModelRef);
  const currentThinkingLevel = useAppStore((s) => s.currentThinkingLevel);
  const selectModel = useAppStore((s) => s.selectModel);
  const selectThinking = useAppStore((s) => s.selectThinking);
  const ensureConversation = useAppStore((s) => s.ensureConversation);
  const sending = useAppStore((s) => s.sending);
  const sendError = useAppStore((s) => s.sendError);
  const retrySend = useAppStore((s) => s.retrySend);

  const canSend = !sending && (value.trim().length > 0 || items.length > 0);

  const submit = (): void => {
    if (!canSend) return;
    const attachments: AttachmentMeta[] = items.map(({ localUrl: _drop, ...meta }) => meta);
    props.onSend(value.trim(), attachments);
    setValue('');
    setItems([]);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const autoGrow = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const capped = Math.min(ta.scrollHeight, ROW_HEIGHT_PX * MAX_INPUT_ROWS);
    ta.style.height = `${capped}px`;
  };

  const removeAttachment = (id: string): void => {
    setItems((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.localUrl?.startsWith('blob:')) URL.revokeObjectURL(target.localUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const pickFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    for (const file of Array.from(files)) {
      try {
        // §5.2：附件必须挂在会话下——无活跃会话先自动建会话（标题取附件名）
        const cid = await ensureConversation(file.name);
        const meta = await getApi().uploadAttachment(cid, file);
        setItems((prev) => [
          ...prev,
          {
            ...meta,
            // 图片缩略图：本地 objectURL 即时预览；环境不支持时退回
            // attachmentRawUrl（mock 为 data: URL，同样可直接渲染）
            localUrl:
              meta.kind === 'image'
                ? typeof URL.createObjectURL === 'function'
                  ? URL.createObjectURL(file)
                  : getApi().attachmentRawUrl(meta.id)
                : undefined,
          },
        ]);
      } catch (err) {
        setUploadError(
          t('attachment.uploadError', {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  };

  return (
    <div className="message-input">
      {sendError ? (
        <div className="error-bar message-input__error" role="alert" data-testid="composer-error">
          <span className="truncate">{sendError}</span>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="composer-retry"
            onClick={() => void retrySend()}
          >
            {t('chat.sendRetry')}
          </button>
        </div>
      ) : uploadError ? (
        <div className="error-bar message-input__error" role="alert" data-testid="composer-error">
          <span className="truncate">{uploadError}</span>
        </div>
      ) : null}

      <textarea
        ref={taRef}
        className="textarea message-input__textarea"
        placeholder={t('chat.input.placeholder')}
        value={value}
        rows={1}
        aria-label={t('chat.input.aria')}
        onChange={(e) => {
          setValue(e.target.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <AttachmentStrip
        items={items}
        imageUrls={Object.fromEntries(
          items
            .filter((a) => a.localUrl !== undefined)
            .map((a) => [a.id, a.localUrl as string]),
        )}
        onRemove={removeAttachment}
      />

      <div className="message-input__toolbar" data-testid="composer-toolbar">
        <button
          type="button"
          className="btn btn--sm message-input__attach"
          data-testid="composer-attach"
          onClick={() => fileRef.current?.click()}
          aria-label={t('composer.attachAria')}
          title={t('composer.attachAria')}
        >
          ＋
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="composer-file-input"
          accept="image/*,.md,.txt,.py,.json,.toml,.csv,.yaml,.ts,.js"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            void pickFiles(e.target.files);
            e.target.value = ''; // 同名文件可重复选择
          }}
        />

        <span className="message-input__spacer" />

        <label className="message-input__label text-secondary" htmlFor="composer-model">
          {t('composer.model')}
        </label>
        <select
          id="composer-model"
          className="select select--composer"
          data-testid="composer-model"
          value={currentModelRef ?? ''}
          disabled={modelChannels.length === 0}
          onChange={(e) => selectModel(e.target.value)}
          aria-label={t('topbar.currentModel')}
        >
          {modelChannels.length === 0 ? (
            <option value="">{t('composer.modelLoading')}</option>
          ) : null}
          {modelChannels.map((channel) => (
            <option key={channel.ref} value={channel.ref}>
              {channel.ref} · {channel.model}
            </option>
          ))}
        </select>

        <label className="message-input__label text-secondary" htmlFor="composer-thinking">
          {t('composer.thinking')}
        </label>
        <select
          id="composer-thinking"
          className="select select--composer select--thinking"
          data-testid="composer-thinking"
          value={currentThinkingLevel ?? parseThinkingLevel(null)}
          disabled={modelChannels.length === 0}
          onChange={(e) => selectThinking(parseThinkingLevel(e.target.value))}
          aria-label={t('topbar.currentThinking')}
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`thinking.${level}`)}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn btn--primary message-input__send"
          data-testid="composer-send"
          onClick={submit}
          disabled={!canSend}
          title={t('chat.input.sendTitle')}
        >
          {sending ? t('chat.input.sending') : t('chat.input.send')}
        </button>
      </div>
    </div>
  );
}
