/**
 * uiStore.ts —— 纯 UI 布局状态（zustand）。
 *
 * 职责：侧栏折叠、检查器开关、检查器 Tab 选择。
 * 交互行为：
 *  - toggleSidebar()：侧栏 264px ↔ 0（<960px 时由 CSS 变为抽屉）；
 *  - toggleInspector()：检查器 360px ↔ 浮层关闭（<1280px 浮层化）；
 *  - selectInspectorTab()：硬件拓扑 / 任务 DAG。
 * 失败行为：无异步/外部 IO，不存在失败路径。
 */
import { create } from 'zustand';

/** 检查器 Tab（design.md §5）。 */
export type InspectorTab = 'hardware' | 'dag';

export interface UiState {
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleInspector: () => void;
  selectInspectorTab: (tab: InspectorTab) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  inspectorOpen: true,
  inspectorTab: 'hardware',
  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  selectInspectorTab: (tab) => set({ inspectorTab: tab }),
}));
