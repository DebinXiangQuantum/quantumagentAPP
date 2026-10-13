/**
 * uiStore.ts —— 纯 UI 布局与偏好状态（zustand）。
 *
 * 职责：
 *  - 布局：侧栏折叠、检查器开关、检查器 Tab 选择、设置页开关；
 *  - 外观偏好（design.md §2.1/§2.2）：主题（dark/light/sepia，写 <html
 *    data-theme> 即时生效）、语言（zh/en/ja）；均持久化 localStorage；
 *  - 模型偏好（§5 设置页）：默认模型 ref、默认思考程度（本地偏好，非渠道配置）。
 * 交互行为：
 *  - toggleSidebar()：侧栏 264px ↔ 0（<960px 时由 CSS 变为抽屉）；
 *  - toggleInspector()：检查器 360px ↔ 浮层关闭（<1280px 浮层化）；
 *  - setTheme()/setLanguage()：即时生效（主题经 applyThemeToDocument；
 *    语言由组件经 useTranslate() 订阅重渲染）。
 * 失败行为：localStorage 不可用（隐私模式/SSR）时静默降级为内存态；
 *   持久化值非法（手改 localStorage）时回退默认值。
 */
import { create } from 'zustand';
import type { ThemeId } from '../styles/tokens';
import type { ThinkingLevel } from '../types/domain';
import { parseThinkingLevel } from '../types/domain';

/** 检查器 Tab（design.md §5）。 */
export type InspectorTab = 'hardware' | 'dag';

/** §2.2 语言（中/EN/JA）。 */
export type Language = 'zh' | 'en' | 'ja';

export const LANGUAGES: readonly Language[] = ['zh', 'en', 'ja'];
export const THEMES: readonly ThemeId[] = ['dark', 'light', 'sepia'];

const THEME_STORAGE = 'qap.theme';
const LANG_STORAGE = 'qap.language';
const PREF_MODEL_STORAGE = 'qap.defaultModelRef';
const PREF_THINKING_STORAGE = 'qap.defaultThinking';

/** localStorage 安全读（不可用/不存在返回 null）。 */
function readStored(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** localStorage 安全写（不可用时静默跳过）。 */
function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等：仅内存态 */
  }
}

function parseLanguage(raw: string | null): Language {
  return raw === 'en' || raw === 'ja' ? raw : 'zh';
}

function parseTheme(raw: string | null): ThemeId {
  return raw === 'light' || raw === 'sepia' ? raw : 'dark';
}

/**
 * 把主题写到 <html data-theme="…">（§2.1：tokens 的 [data-theme] 覆盖块生效）。
 * 可注入 documentRef 供测试；无 document 环境（SSR）静默跳过。
 */
export function applyThemeToDocument(theme: ThemeId, documentRef?: Document): void {
  const target = documentRef ?? (typeof document !== 'undefined' ? document : null);
  if (!target || typeof target.documentElement?.setAttribute !== 'function') {
    return;
  }
  target.documentElement.setAttribute('data-theme', theme);
}

export interface UiState {
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  /** §5 v1.1 设置页（覆盖侧栏+对话区，检查器保留） */
  settingsOpen: boolean;
  theme: ThemeId;
  language: Language;
  /** §5 设置页「模型与思考」：本地偏好（null = 未设置，随渠道默认） */
  defaultModelRef: string | null;
  defaultThinking: ThinkingLevel | null;

  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleInspector: () => void;
  selectInspectorTab: (tab: InspectorTab) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setTheme: (theme: ThemeId) => void;
  setLanguage: (language: Language) => void;
  setDefaultModelRef: (ref: string | null) => void;
  setDefaultThinking: (level: ThinkingLevel | null) => void;
  /** 仅供测试：复位为默认值并清理本会话偏好持久化。 */
  resetForTest: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  inspectorOpen: true,
  inspectorTab: 'hardware',
  settingsOpen: false,
  theme: parseTheme(readStored(THEME_STORAGE)),
  language: parseLanguage(readStored(LANG_STORAGE)),
  defaultModelRef: readStored(PREF_MODEL_STORAGE),
  defaultThinking: (() => {
    const raw = readStored(PREF_THINKING_STORAGE);
    return raw === null || raw === '' ? null : parseThinkingLevel(raw);
  })(),

  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  selectInspectorTab: (tab) => set({ inspectorTab: tab }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setTheme: (theme) => {
    writeStored(THEME_STORAGE, theme);
    applyThemeToDocument(theme);
    set({ theme });
  },
  setLanguage: (language) => {
    writeStored(LANG_STORAGE, language);
    set({ language });
  },
  setDefaultModelRef: (ref) => {
    if (ref === null || ref === '') {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(PREF_MODEL_STORAGE);
      } catch {
        /* 忽略 */
      }
      set({ defaultModelRef: null });
      return;
    }
    writeStored(PREF_MODEL_STORAGE, ref);
    set({ defaultModelRef: ref });
  },
  setDefaultThinking: (level) => {
    if (level === null) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(PREF_THINKING_STORAGE);
      } catch {
        /* 忽略 */
      }
      set({ defaultThinking: null });
      return;
    }
    writeStored(PREF_THINKING_STORAGE, level);
    set({ defaultThinking: level });
  },
  resetForTest: () => {
    for (const key of [THEME_STORAGE, LANG_STORAGE, PREF_MODEL_STORAGE, PREF_THINKING_STORAGE]) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
      } catch {
        /* 忽略 */
      }
    }
    set({
      sidebarCollapsed: false,
      inspectorOpen: true,
      inspectorTab: 'hardware',
      settingsOpen: false,
      theme: 'dark',
      language: 'zh',
      defaultModelRef: null,
      defaultThinking: null,
    });
  },
}));

// 启动即应用持久化主题（首帧即正确主题，无白闪）
applyThemeToDocument(useUiStore.getState().theme);
