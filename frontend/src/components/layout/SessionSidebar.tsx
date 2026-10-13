/**
 * SessionSidebar.tsx —— 264px 会话侧栏（design.md §5）。
 *
 * 职责：会话列表（本切片为结构占位，S2/S3 接入数据）+「新建会话」入口。
 * Props 契约：无 props。
 * 交互行为：
 *  - 折叠由 AppShell 的 grid 列宽控制（data-collapsed 由父级 store 传入）；
 *  - 新建按钮 / 会话项均键盘可达。
 */
import { useUiStore } from '../../store/uiStore';

export function SessionSidebar(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  return (
    <aside
      className="session-sidebar"
      data-testid="session-sidebar"
      data-collapsed={String(collapsed)}
      aria-label="会话侧栏"
    >
      <div className="panel-header">
        <span className="panel-header__title">会话</span>
        <button type="button" className="btn btn--sm" title="以当前 Agent 新建会话">
          + 新建
        </button>
      </div>
      <div className="session-sidebar__list" data-testid="conversation-list">
        {/* 数据切片接入前：占位空态 */}
        <p className="empty-hint text-faint">暂无会话</p>
      </div>
    </aside>
  );
}
