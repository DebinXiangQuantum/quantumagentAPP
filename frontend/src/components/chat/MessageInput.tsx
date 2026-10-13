/**
 * MessageInput.tsx —— 多行输入区（design.md §5，v1.1 修订）。
 *
 * 职责：
 *  - textarea 自适应增高（cap 8 行）；
 *  - Enter 发送 / Shift+Enter 换行；纯空白不发送；
 *  - 「发送 ⏎」主按钮（空内容禁用）；
 *  - v1.1：移除 Agent 快捷切换（编排 Agent 自动调度，用户不选 Agent；
 *    模型/思考选择器在顶栏）。
 * Props 契约：{ onSend: (text: string) => void }——组件自身不直接访问发送 API，
 *  便于测试注入。
 */
import { useRef, useState } from 'react';
import { TOKENS } from '../../styles/tokens';
import { useTranslate } from '../../i18n';

const MAX_INPUT_ROWS = 8;
/** 单行高度 = fs-body × lh-body（token 派生，避免硬编码行高）。 */
const ROW_HEIGHT_PX =
  parseFloat(TOKENS.fontSize.body) * parseFloat(TOKENS.lineHeight.body);

export function MessageInput(props: { onSend: (text: string) => void }): JSX.Element {
  const t = useTranslate();
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    props.onSend(trimmed);
    setValue('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const autoGrow = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const capped = Math.min(ta.scrollHeight, ROW_HEIGHT_PX * MAX_INPUT_ROWS);
    ta.style.height = `${capped}px`;
  };

  return (
    <div className="message-input">
      <div className="message-input__row">
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
        <button
          type="button"
          className="btn btn--primary message-input__send"
          onClick={submit}
          disabled={value.trim().length === 0}
          title={t('chat.input.sendTitle')}
        >
          {t('chat.input.send')}
        </button>
      </div>
    </div>
  );
}
