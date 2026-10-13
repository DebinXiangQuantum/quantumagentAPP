/**
 * MessageInput.tsx —— 多行输入区（design.md §5）。
 *
 * 职责：
 *  - textarea 自适应增高（cap 8 行）；
 *  - Enter 发送 / Shift+Enter 换行；纯空白不发送；
 *  - 「发送 ⏎」主按钮（空内容禁用）；
 *  - Agent 快捷切换（写入 store.currentAgentId，影响后续新建会话）。
 * Props 契约：{ onSend: (text: string) => void }——组件自身不直接访问发送 API，
 *  便于测试注入。
 */
import { useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { TOKENS } from '../../styles/tokens';

const MAX_INPUT_ROWS = 8;
/** 单行高度 = fs-body × lh-body（token 派生，避免硬编码行高）。 */
const ROW_HEIGHT_PX =
  parseFloat(TOKENS.fontSize.body) * parseFloat(TOKENS.lineHeight.body);

export function MessageInput(props: { onSend: (text: string) => void }): JSX.Element {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const agents = useAppStore((s) => s.agents);
  const currentAgentId = useAppStore((s) => s.currentAgentId);
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent);

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
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          value={value}
          rows={1}
          aria-label="消息输入"
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
          title="发送（Enter）"
        >
          发送 ⏎
        </button>
      </div>
      <div className="message-input__toolbar">
        <label className="text-faint message-input__agent-label" htmlFor="composer-agent">
          Agent
        </label>
        <select
          id="composer-agent"
          className="select select--composer"
          aria-label="快捷切换 Agent"
          value={currentAgentId ?? agents[0]?.id ?? ''}
          disabled={agents.length === 0}
          onChange={(e) => setCurrentAgent(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
