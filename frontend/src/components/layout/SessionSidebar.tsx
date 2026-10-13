/**
 * SessionSidebar.tsx —— 264px 会话侧栏（design.md §5，v1.1 增底部设置入口）。
 *
 * 职责：会话列表（点击切换 activeConversationId → store 挂载会话 SSE 流）、
 *      「+ 新建」按钮（v1.1：不再选 Agent，orchestrator 编排入口）、
 *      Agent 名副标题（历史会话归属展示）、底部齿轮「设置」入口
 *      （uiStore.openSettings → 设置页覆盖侧栏+对话区）。
 * Props 契约：无 props。
 * 降级行为：会话为空 → 插画式空态文案；标题/副行 min-width:0 + 截断（§5.1）。
 */
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { formatRelativeTime } from '../../utils/format';
import { ConversationListSkeleton } from '../common/Skeletons';
import { useTranslate } from '../../i18n';

/** 齿轮图标（16px，stroke 跟随文字色）。 */
function GearIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="2.4"
        fill="none"
        strokeWidth="1.4"
        className="svg-stroke-current"
      />
      <path
        d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
        fill="none"
        strokeWidth="1.4"
        className="svg-stroke-current"
      />
    </svg>
  );
}

export function SessionSidebar(): JSX.Element {
  const t = useTranslate();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const openSettings = useUiStore((s) => s.openSettings);
  const conversations = useAppStore((s) => s.conversations);
  const agents = useAppStore((s) => s.agents);
  const activeCid = useAppStore((s) => s.activeConversationId);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const createConversation = useAppStore((s) => s.createConversation);
  const booted = useAppStore((s) => s.booted);
  const bootError = useAppStore((s) => s.bootError);

  const agentName = (agentId: string): string =>
    agents.find((a) => a.id === agentId)?.name ?? agentId;

  const handleCreate = (): void => {
    void createConversation();
  };

  return (
    <aside
      className="session-sidebar"
      data-testid="session-sidebar"
      data-collapsed={String(collapsed)}
      aria-label={t('sidebar.aria')}
    >
      <div className="panel-header">
        <span className="panel-header__title">{t('sidebar.title')}</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={handleCreate}
          title={t('sidebar.newTitle')}
        >
          {t('sidebar.new')}
        </button>
      </div>
      <div className="session-sidebar__list" data-testid="conversation-list">
        {!booted && !bootError ? (
          <ConversationListSkeleton count={4} />
        ) : conversations.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">{t('sidebar.empty.title')}</p>
            <p className="empty-state__hint">{t('sidebar.empty.hint')}</p>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleCreate}
            >
              {t('sidebar.empty.action')}
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
                  <span className="conversation-item__meta mono truncate">
                    {agentName(conv.agent_id)} · {formatRelativeTime(conv.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="session-sidebar__footer">
        <button
          type="button"
          className="session-sidebar__settings"
          data-testid="open-settings"
          onClick={openSettings}
          aria-label={t('sidebar.settings')}
        >
          <GearIcon />
          <span className="truncate">{t('sidebar.settings')}</span>
        </button>
      </div>
    </aside>
  );
}
