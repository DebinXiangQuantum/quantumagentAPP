/**
 * AppShell.tsx —— 应用外壳：56px 顶栏 + 三栏主体（design.md §5）。
 *
 * 职责：
 *  - 组合 TopBar / SessionSidebar / ChatPanel / InspectorPanel；
 *  - 以 CSS Grid 实现 264px · 流体(max 820px 对话列) · 360px 三栏；
 *  - 响应式：<1280px 检查器浮层化，<960px 侧栏抽屉化（见 layout.css）。
 *
 * Props 契约：无 props（全部状态来自全局 store / 子组件自取）。
 * 交互行为：折叠按钮在 TopBar；data-collapsed 供测试与 CSS 断言。
 */
import { TopBar } from './TopBar';
import { SessionSidebar } from './SessionSidebar';
import { ChatPanel } from '../chat/ChatPanel';
import { InspectorPanel } from './InspectorPanel';
import { useUiStore } from '../../store/uiStore';

export function AppShell(): JSX.Element {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);

  return (
    <div className="app-shell">
      <TopBar />
      <div
        className={[
          'app-main',
          sidebarCollapsed ? 'app-main--sidebar-collapsed' : '',
          inspectorOpen ? '' : 'app-main--inspector-collapsed',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <SessionSidebar />
        <ChatPanel />
        <InspectorPanel />
      </div>
    </div>
  );
}
