/**
 * TopBar.tsx —— 56px 顶栏（design.md §5）。
 *
 * 职责：
 *  - 左：侧栏折叠按钮 + 产品名「QuantumAgent · 异构量子智能体平台」；
 *  - 中：当前 Agent 选择器（切换影响新会话/快捷切换，S2 接入数据）；
 *  - 右：租户徽标、SSE 连接状态灯（S2 接入 store）、检查器开关。
 *
 * Props 契约：无 props；连接状态/租户/Agent 列表均来自全局 store（本切片先以
 * 占位默认值渲染，数据切片接入后自动点亮）。
 * 交互行为：三个 icon 按钮均可键盘触发（focus-visible ring 全局生效）。
 */
import { useUiStore } from '../../store/uiStore';
import { ConnectionLight } from './ConnectionLight';

export function TopBar(): JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);

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
        <select id="topbar-agent" className="select select--topbar" defaultValue="algorithm-designer">
          <option value="algorithm-designer">量子算法设计</option>
          <option value="calibration">量子校准 / 波形</option>
          <option value="echo">回显测试</option>
        </select>
      </div>

      <div className="topbar__right">
        <span className="tenant-badge mono" title="当前租户">
          demo
        </span>
        <ConnectionLight />
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
