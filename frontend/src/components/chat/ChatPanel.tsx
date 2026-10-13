/**
 * ChatPanel.tsx —— 对话区容器（design.md §5）。
 *
 * 职责：居中流体列（内容 max 820px）承载消息流 + Artifact 卡片 + 输入区。
 *       本切片为结构占位；消息流 / 输入 / 流式光标在 S3 切片实现。
 * Props 契约：无 props。
 * 交互行为：无（占位）。
 */
export function ChatPanel(): JSX.Element {
  return (
    <section
      className="chat-panel"
      data-testid="chat-panel"
      aria-label="对话区"
    >
      <div className="chat-panel__inner">
        <p className="empty-hint text-faint" data-testid="chat-placeholder">
          对话区待接入
        </p>
      </div>
    </section>
  );
}
