/**
 * ConnectionLight.tsx —— 顶栏 SSE 连接状态灯（design.md §7）。
 *
 * 职责：绿=已连接 / 黄=连接中 / 红=已断开，附文字标签。
 * Props 契约：{ status?: 'online' | 'connecting' | 'offline' }，缺省 'connecting'
 *  （数据切片接入后由 store 驱动；畸形值一律按 connecting 降级，不崩溃）。
 * 交互行为：纯展示，title 提示完整状态。
 */
export type ConnectionStatus = 'online' | 'connecting' | 'offline';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  online: '已连接',
  connecting: '连接中',
  offline: '已断开',
};

export function parseConnectionStatus(raw: unknown): ConnectionStatus {
  return raw === 'online' || raw === 'offline' ? raw : 'connecting';
}

export function ConnectionLight(props: { status?: ConnectionStatus }): JSX.Element {
  const status = parseConnectionStatus(props.status);
  return (
    <span
      className={`conn-light conn-light--${status}`}
      title={`SSE ${STATUS_TEXT[status]}`}
      role="status"
      data-testid="conn-light"
    >
      <span className="conn-light__dot" aria-hidden="true" />
      <span className="conn-light__label">{STATUS_TEXT[status]}</span>
    </span>
  );
}
