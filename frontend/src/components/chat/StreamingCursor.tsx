/**
 * StreamingCursor.tsx —— 流式消息末尾的闪烁光标（design.md §7）。
 *
 * 职责：1px 宽青色竖条，530ms steps 闪烁；`fading` 时停止闪烁并以 120ms 淡出
 *      （消息完成后由父级短暂渲染 fading 态再卸载）。
 * Props 契约：{ fading?: boolean }（缺省 false；畸形值按 false）。
 * 交互行为：纯视觉，无交互。
 */
export function StreamingCursor(props: { fading?: boolean }): JSX.Element {
  const fading = props.fading === true;
  return (
    <span
      className={
        fading ? 'streaming-cursor streaming-cursor--fade' : 'streaming-cursor'
      }
      data-testid="streaming-cursor"
      aria-hidden="true"
    />
  );
}
