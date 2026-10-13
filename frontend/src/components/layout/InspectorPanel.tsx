/**
 * InspectorPanel.tsx —— 360px 检查器面板（design.md §5/§6，v1.1 i18n）。
 *
 * 职责：Tab 切换「硬件拓扑 / 任务 DAG」；
 *  - 硬件拓扑：HardwareTopology（store.hardwareNodes + 任务回溯 + 利用率历史）；
 *  - 任务 DAG：当前会话的任务列表（无则全量），逐个 DagView 渲染。
 * Props 契约：无 props；Tab 状态来自 uiStore，数据来自 appStore。
 * 交互行为：tablist/tab 语义（aria-selected）；<1280px 由 CSS 浮层化。
 */
import { useUiStore, type InspectorTab } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { HardwareTopology } from '../viz/HardwareTopology';
import { DagView } from '../viz/DagView';
import { DagSkeleton, HwGridSkeleton } from '../common/Skeletons';
import { useTranslate } from '../../i18n';

const TABS: ReadonlyArray<{ id: InspectorTab; key: string }> = [
  { id: 'hardware', key: 'inspector.tab.hardware' },
  { id: 'dag', key: 'inspector.tab.dag' },
];

export function InspectorPanel(): JSX.Element {
  const t = useTranslate();
  const open = useUiStore((s) => s.inspectorOpen);
  const activeTab = useUiStore((s) => s.inspectorTab);
  const selectTab = useUiStore((s) => s.selectInspectorTab);

  const hardwareNodes = useAppStore((s) => s.hardwareNodes);
  const tasks = useAppStore((s) => s.tasks);
  const history = useAppStore((s) => s.utilHistoryByNode);
  const activeCid = useAppStore((s) => s.activeConversationId);
  const booted = useAppStore((s) => s.booted);
  const bootError = useAppStore((s) => s.bootError);

  // 当前会话的任务优先；无则展示全部（跨会话可观察）
  const scopedTasks = activeCid
    ? tasks.filter((tk) => tk.conversation_id === activeCid)
    : [];
  const visibleTasks = scopedTasks.length > 0 ? scopedTasks : tasks;

  return (
    <aside
      className="inspector-panel"
      data-testid="inspector-panel"
      data-collapsed={String(!open)}
      aria-label={t('inspector.aria')}
    >
      <div className="inspector-panel__tabs" role="tablist" aria-label={t('inspector.tabs')}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => selectTab(tab.id)}
          >
            {t(tab.key)}
          </button>
        ))}
      </div>
      <div className="inspector-panel__body">
        {!booted && !bootError ? (
          // loading：同构骨架（硬件卡片 / DAG 节点）
          activeTab === 'hardware' ? (
            <HwGridSkeleton count={4} />
          ) : (
            <DagSkeleton />
          )
        ) : activeTab === 'hardware' ? (
          <HardwareTopology nodes={hardwareNodes} tasks={tasks} history={history} />
        ) : (
          <div className="inspector-panel__dags">
            {visibleTasks.length === 0 ? (
              <DagView task={null} />
            ) : (
              visibleTasks.map((task) => <DagView key={task.id} task={task} />)
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
