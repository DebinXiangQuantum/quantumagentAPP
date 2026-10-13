/**
 * InspectorPanel.tsx —— 360px 检查器面板（design.md §5）。
 *
 * 职责：Tab 切换「硬件拓扑 / 任务 DAG」；内容区由后续切片填充
 *      （HardwareTopology / DagView）。
 * Props 契约：无 props；Tab 状态来自 uiStore。
 * 交互行为：tablist/tab 语义键盘切换（aria-selected）；
 *          <1280px 时由 CSS 浮层化并出现遮罩。
 */
import { useUiStore, type InspectorTab } from '../../store/uiStore';

const TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'hardware', label: '硬件拓扑' },
  { id: 'dag', label: '任务 DAG' },
];

export function InspectorPanel(): JSX.Element {
  const open = useUiStore((s) => s.inspectorOpen);
  const activeTab = useUiStore((s) => s.inspectorTab);
  const selectTab = useUiStore((s) => s.selectInspectorTab);

  return (
    <aside
      className="inspector-panel"
      data-testid="inspector-panel"
      data-collapsed={String(!open)}
      aria-label="检查器"
    >
      <div className="inspector-panel__tabs" role="tablist" aria-label="检查器视图">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => selectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inspector-panel__body">
        {activeTab === 'hardware' ? (
          <p className="empty-hint text-faint" data-testid="hardware-tab-content">
            硬件拓扑待接入
          </p>
        ) : (
          <p className="empty-hint text-faint" data-testid="dag-tab-content">
            任务 DAG 待接入
          </p>
        )}
      </div>
    </aside>
  );
}
