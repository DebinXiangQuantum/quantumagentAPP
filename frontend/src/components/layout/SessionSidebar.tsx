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
/** IBM Carbon "settings" 齿轮图标（16px，外齿圈 + 中孔，经典齿轮形状）。 */
function GearIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M14.94 5.76l-1.32-.28a5.9 5.9 0 00-.46-1.11l.74-1.13-1.65-1.65-1.13.74c-.35-.19-.72-.34-1.11-.46L9.73.56h-2.33l-.28 1.31c-.4.12-.77.27-1.12.46l-1.13-.74L3.23 3.24l.74 1.13c-.2.35-.35.72-.47 1.11l-1.31.28v2.33l1.31.28c.12.4.27.77.47 1.12l-.74 1.13 1.65 1.65 1.13-.74c.35.2.72.35 1.11.47l.28 1.31h2.33l.28-1.31c.39-.12.76-.27 1.11-.47l1.13.75 1.65-1.65-.74-1.13c.19-.35.34-.72.46-1.11l1.31-.28V5.76zM7.94 10.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"
        fill="currentColor"
        stroke="none"
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
