/**
 * TopBar.tsx —— 56px 顶栏（design.md §5）。
 *
 * 职责：
 *  - 左：侧栏折叠按钮 + 产品名「QuantumAgent · 异构量子智能体平台」；
 *  - 中：当前 Agent 选择器（写入 store.currentAgentId，驱动新建会话/快捷切换）；
 *  - 右：租户徽标、SSE 连接状态灯（store.connection）、检查器开关。
 *
 * Props 契约：无 props；全部来自 useAppStore / useUiStore。
 * 降级行为：agents 未加载时选择器禁用；tenant 未知时显示占位「—」。
 */
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { ConnectionLight } from './ConnectionLight';

export function TopBar(): JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);

  const agents = useAppStore((s) => s.agents);
  const tenant = useAppStore((s) => s.tenant);
  const connection = useAppStore((s) => s.connection);
  const currentAgentId = useAppStore((s) => s.currentAgentId);
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent);

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          type="button"
          className="icon-btn"
          data-testid="toggle-sidebar"
          onClick={toggleSidebar}
          aria-label="切换会话侧栏"
          title="切换会话侧栏"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1" y="2" width="14" height="1.5" className="svg-fill-current" />
            <rect x="1" y="7.25" width="14" height="1.5" className="svg-fill-current" />
            <rect x="1" y="12.5" width="14" height="1.5" className="svg-fill-current" />
          </svg>
        </button>
        <span className="topbar__product">QuantumAgent · 异构量子智能体平台</span>
      </div>

      <div className="topbar__center">
        <label className="topbar__agent-label text-secondary" htmlFor="topbar-agent">
          Agent
        </label>
        <select
          id="topbar-agent"
          className="select select--topbar"
          value={currentAgentId ?? agents[0]?.id ?? ''}
          disabled={agents.length === 0}
          onChange={(e) => setCurrentAgent(e.target.value)}
          aria-label="当前 Agent"
        >
          {agents.length === 0 ? <option value="">（加载中）</option> : null}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="topbar__right">
        <span className="tenant-badge mono" title={`租户：${tenant?.name ?? '未知'}`}>
          {tenant?.id ?? '—'}
        </span>
        <ConnectionLight status={connection} />
        <button
          type="button"
          className="icon-btn"
          data-testid="toggle-inspector"
          onClick={toggleInspector}
          aria-label="切换检查器面板"
          title="切换检查器面板"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="1.75"
              y="2.75"
              width="12.5"
              height="10.5"
              rx="1.5"
              fill="none"
              strokeWidth="1.5"
              className="svg-stroke-current"
            />
            <line
              x1="9.5"
              y1="2.75"
              x2="9.5"
              y2="13.25"
              strokeWidth="1.5"
              className="svg-stroke-current"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
