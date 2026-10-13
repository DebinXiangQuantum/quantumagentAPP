/**
 * SessionSidebar.tsx —— 264px 会话侧栏（design.md §5）。
 *
 * 职责：会话列表（点击切换 activeConversationId → store 挂载会话 SSE 流）、
 *      「+ 新建」按钮（以 currentAgentId 创建会话）、Agent 名副标题。
 * Props 契约：无 props。
 * 降级行为：会话为空 → 插画式空态文案；新建失败 → alert 风格错误条（streamError）。
 */
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { formatRelativeTime } from '../../utils/format';

export function SessionSidebar(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const conversations = useAppStore((s) => s.conversations);
  const agents = useAppStore((s) => s.agents);
  const activeCid = useAppStore((s) => s.activeConversationId);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const createConversation = useAppStore((s) => s.createConversation);
  const currentAgentId = useAppStore((s) => s.currentAgentId);

  const agentName = (agentId: string): string =>
    agents.find((a) => a.id === agentId)?.name ?? agentId;

  const handleCreate = (): void => {
    const agentId = currentAgentId ?? agents[0]?.id;
    if (agentId) void createConversation(agentId);
  };

  return (
    <aside
      className="session-sidebar"
      data-testid="session-sidebar"
      data-collapsed={String(collapsed)}
      aria-label="会话侧栏"
    >
      <div className="panel-header">
        <span className="panel-header__title">会话</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={handleCreate}
          disabled={agents.length === 0}
          title="以当前 Agent 新建会话"
        >
          + 新建
        </button>
      </div>
      <div className="session-sidebar__list" data-testid="conversation-list">
        {conversations.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">暂无会话</p>
            <p className="empty-state__hint">
              创建第一个会话，让 Agent 开始为你工作。
            </p>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleCreate}
            >
              新建会话
            </button>
          </div>
        ) : (
          <ul className="conversation-list">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  className={[
                    'conversation-item',
                    conv.id === activeCid ? 'conversation-item--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-conversation-id={conv.id}
                  onClick={() => void selectConversation(conv.id)}
                  aria-current={conv.id === activeCid ? 'true' : undefined}
                >
                  <span className="conversation-item__title truncate">
                    {conv.title}
                  </span>
                  <span className="conversation-item__meta mono">
                    {agentName(conv.agent_id)} · {formatRelativeTime(conv.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
