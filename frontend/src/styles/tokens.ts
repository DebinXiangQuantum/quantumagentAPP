/**
 * tokens.ts —— QuantumAgentApp 前端设计系统的**唯一来源**（design.md §2–§4、§5、§7、§2.1）。
 *
 * 职责：
 *  - 以 TypeScript 常量定义全部颜色/字体/字号/间距/圆角/阴影/z-index/动效/布局尺寸；
 *  - `buildTokenCss()` 将其编译为 `:root { --* }`（=dark，默认）+
 *    `[data-theme="light"] { … }` + `[data-theme="sepia"] { … }` 三块 CSS 变量，
 *    由 main.tsx 注入（保证 CSS 与 TS 永远同源，杜绝手抄漂移）；
 *  - 浅色/护眼主题**只覆盖颜色与阴影 token**（§2.1），几何/字号/间距三主题共用；
 *  - SVG 等需要具体几何数值的场景引用 `TOKENS`（如线路格点 44×36），
 *    组件中**禁止**出现任何未走 token 的颜色/字号/间距字面量。
 *
 * 失败行为：本模块为纯常量，无运行时失败路径；测试逐字校验与 design.md 一致。
 */

/** §2 色板（深空暗色主题）。键名与 CSS 变量一一对应（camelCase ↔ kebab-case）。 */
export interface ColorTokens {
  bgBase: string;
  bgSurface: string;
  bgElevated: string;
  bgInset: string;
  borderDefault: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textFaint: string;
  accentCyan: string;
  accentViolet: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

/** §2.1 主题 = 色板 + 阴影（浅色/护眼阴影降档覆盖 --shadow-1/2）。 */
export interface ThemePalette {
  color: ColorTokens;
  shadow: { s1: string; s2: string };
}

export type ThemeId = 'dark' | 'light' | 'sepia';

export const TOKENS = {
  color: {
    bgBase: '#0B0E14',
    bgSurface: '#11151F',
    bgElevated: '#161B28',
    bgInset: '#0D1117',
    borderDefault: '#232A3A',
    borderStrong: '#2E3A50',
    textPrimary: '#E8ECF4',
    textSecondary: '#9AA4B8',
    textFaint: '#5C667A',
    accentCyan: '#4FD8EB',
    accentViolet: '#8B7CF6',
    success: '#3DD68C',
    warning: '#F5B455',
    danger: '#F26D6D',
    info: '#5CA8FF',
  } as ColorTokens,
  /** §3 字体栈（用户逐字指定；不引入 webfont 文件，纯系统字体栈）。 */
  font: {
    ui: '"Microsoft YaHei","微软雅黑","PingFang SC",Arial,"Helvetica Neue",sans-serif',
    data: '"JetBrains Mono",Consolas,"SF Mono",Menlo,monospace',
    serif: '"Times New Roman",Times,serif',
  },
  /** §3 字号阶（仅此 5 档）与行高。 */
  fontSize: {
    caption: '12px',
    body: '13px',
    bodyLg: '15px',
    title: '18px',
    display: '22px',
  },
  lineHeight: {
    body: '1.6',
    data: '1.45',
    title: '1.3',
  },
  /** §4 间距（8px 网格 7 档）。 */
  space: {
    s4: '4px',
    s8: '8px',
    s12: '12px',
    s16: '16px',
    s24: '24px',
    s32: '32px',
    s48: '48px',
  },
  /** §4 圆角。 */
  radius: {
    sm: '6px',
    md: '10px',
    lg: '14px',
  },
  /** §4 双层低饱和阴影（dark）。 */
  shadow: {
    s1: '0 1px 2px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.03)',
    s2: '0 8px 24px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04)',
  },
  /** §4 z-index 阶。 */
  zIndex: {
    base: 0,
    sticky: 10,
    drawer: 100,
    toast: 200,
  },
  /** §7 动效：UI 过渡 ≤200ms；循环类（光标/骨架/呼吸/条形生长）为指定时长。 */
  motion: {
    fast: '120ms',
    panel: '200ms',
    easeOut: 'cubic-bezier(.2,.7,.3,1)',
    cursorBlink: '530ms',
    shimmer: '1.2s',
    glowBreath: '2s',
    barGrow: '160ms',
  },
  /** §5 布局尺寸。 */
  layout: {
    topbarHeight: '56px',
    sidebarWidth: '264px',
    inspectorWidth: '360px',
    chatMaxWidth: '820px',
  },
  /** §6.1 线路画布几何：单位格 44×36；qubit 标签列 40；>32 qubits 截断。 */
  circuit: {
    cellW: 44,
    cellH: 36,
    labelW: 40,
    padY: 16,
    maxQubits: 32,
  },
} as const;

/** §2.1 浅色主题（只覆盖颜色；阴影降为 rgba(15,23,42,.08) 档）。 */
export const LIGHT_THEME: ThemePalette = {
  color: {
    bgBase: '#F5F7FA',
    bgSurface: '#FFFFFF',
    bgElevated: '#FFFFFF',
    bgInset: '#EEF1F6',
    borderDefault: '#D9DFEA',
    borderStrong: '#C6CFDE',
    textPrimary: '#1F2733',
    textSecondary: '#5A6577',
    textFaint: '#8B95A6',
    accentCyan: '#0E8A9E',
    accentViolet: '#6C5CE7',
    success: '#1F9D66',
    warning: '#C77F1D',
    danger: '#D24E4E',
    info: '#2E7CD6',
  },
  shadow: {
    s1: '0 1px 2px rgba(15,23,42,.08)',
    s2: '0 2px 8px rgba(15,23,42,.10)',
  },
};

/** §2.1 护眼（sepia）主题（只覆盖颜色；阴影同浅色降档）。 */
export const SEPIA_THEME: ThemePalette = {
  color: {
    bgBase: '#F5F0E1',
    bgSurface: '#FBF7EC',
    bgElevated: '#FFFCF2',
    bgInset: '#EFE7D2',
    borderDefault: '#E0D5B8',
    borderStrong: '#CBBE9C',
    textPrimary: '#3E3A2F',
    textSecondary: '#6E6753',
    textFaint: '#6B6249',
    accentCyan: '#2A7F8F',
    accentViolet: '#7B6FD0',
    success: '#3E7345',
    warning: '#B07C28',
    danger: '#B5544A',
    info: '#3D6FA8',
  },
  shadow: {
    s1: '0 1px 2px rgba(15,23,42,.08)',
    s2: '0 2px 8px rgba(15,23,42,.10)',
  },
};

/** camelCase 色板键 → kebab-case CSS 变量名（15 个颜色 token 的权威顺序清单）。 */
const COLOR_ENTRIES: ReadonlyArray<[keyof ColorTokens, string]> = [
  ['bgBase', 'bg-base'],
  ['bgSurface', 'bg-surface'],
  ['bgElevated', 'bg-elevated'],
  ['bgInset', 'bg-inset'],
  ['borderDefault', 'border-default'],
  ['borderStrong', 'border-strong'],
  ['textPrimary', 'text-primary'],
  ['textSecondary', 'text-secondary'],
  ['textFaint', 'text-faint'],
  ['accentCyan', 'accent-cyan'],
  ['accentViolet', 'accent-violet'],
  ['success', 'success'],
  ['warning', 'warning'],
  ['danger', 'danger'],
  ['info', 'info'],
];

/** 颜色 token 的 CSS 变量名清单（测试与主题块生成共用）。 */
export const COLOR_VARIABLE_NAMES: readonly string[] = COLOR_ENTRIES.map(
  ([, cssName]) => cssName,
);

/** token 的 CSS 变量名（不含前缀 `--`）与值。生成 :root 块与测试均以此为权威清单。 */
export const CSS_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  // —— §2 色板 ——
  ...COLOR_ENTRIES.map(
    ([key, cssName]) => [cssName, TOKENS.color[key]] as const,
  ),
  // —— §3 字体 / 字号 / 行高 ——
  ['font-ui', TOKENS.font.ui],
  ['font-data', TOKENS.font.data],
  ['font-serif', TOKENS.font.serif],
  ['fs-caption', TOKENS.fontSize.caption],
  ['fs-body', TOKENS.fontSize.body],
  ['fs-body-lg', TOKENS.fontSize.bodyLg],
  ['fs-title', TOKENS.fontSize.title],
  ['fs-display', TOKENS.fontSize.display],
  ['lh-body', TOKENS.lineHeight.body],
  ['lh-data', TOKENS.lineHeight.data],
  ['lh-title', TOKENS.lineHeight.title],
  // —— §4 间距 / 圆角 / 阴影 / z-index ——
  ['space-4', TOKENS.space.s4],
  ['space-8', TOKENS.space.s8],
  ['space-12', TOKENS.space.s12],
  ['space-16', TOKENS.space.s16],
  ['space-24', TOKENS.space.s24],
  ['space-32', TOKENS.space.s32],
  ['space-48', TOKENS.space.s48],
  ['radius-sm', TOKENS.radius.sm],
  ['radius-md', TOKENS.radius.md],
  ['radius-lg', TOKENS.radius.lg],
  ['shadow-1', TOKENS.shadow.s1],
  ['shadow-2', TOKENS.shadow.s2],
  ['z-base', String(TOKENS.zIndex.base)],
  ['z-sticky', String(TOKENS.zIndex.sticky)],
  ['z-drawer', String(TOKENS.zIndex.drawer)],
  ['z-toast', String(TOKENS.zIndex.toast)],
  // —— §7 动效 ——
  ['motion-fast', TOKENS.motion.fast],
  ['motion-panel', TOKENS.motion.panel],
  ['ease-out', TOKENS.motion.easeOut],
  ['motion-cursor-blink', TOKENS.motion.cursorBlink],
  ['motion-shimmer', TOKENS.motion.shimmer],
  ['motion-glow-breath', TOKENS.motion.glowBreath],
  ['motion-bar-grow', TOKENS.motion.barGrow],
  // —— §5 布局尺寸 ——
  ['topbar-height', TOKENS.layout.topbarHeight],
  ['sidebar-width', TOKENS.layout.sidebarWidth],
  ['inspector-width', TOKENS.layout.inspectorWidth],
  ['chat-max-width', TOKENS.layout.chatMaxWidth],
];

/** 主题覆盖块内容：15 个颜色 + 阴影 2 个（§2.1：几何/字号/间距三主题共用）。 */
function themeBlock(theme: ThemePalette, scheme: 'dark' | 'light'): string {
  const body = COLOR_ENTRIES.map(
    ([key, cssName]) => `--${cssName}:${theme.color[key]}`,
  )
    .concat([`--shadow-1:${theme.shadow.s1}`, `--shadow-2:${theme.shadow.s2}`])
    .concat([`color-scheme:${scheme}`])
    .join(';');
  return body;
}

/**
 * 生成三主题 CSS 文本（紧凑单行，main.tsx 以 <style> 注入）：
 * `:root{…}`（=dark 全量 token）+ `[data-theme="light"]{…}` +
 * `[data-theme="sepia"]{…}`（后两者仅覆盖颜色与阴影）。
 * 假设：仅在应用启动时调用一次；变量名与值均为受控字面量，无需转义。
 */
export function buildTokenCss(): string {
  const rootBody = CSS_VARIABLES.map(([name, value]) => `--${name}:${value}`)
    .concat(['color-scheme:dark'])
    .join(';');
  return (
    `:root{${rootBody}}` +
    `[data-theme="light"]{${themeBlock(LIGHT_THEME, 'light')}}` +
    `[data-theme="sepia"]{${themeBlock(SEPIA_THEME, 'light')}}`
  );
}
/** 将 token CSS 注入 document.head（幂等：重复调用不重复插入）。供 main.tsx 与测试使用。 */
export function injectTokenStyles(documentRef: Document): void {
  const STYLE_ID = 'qap-design-tokens';
  if (documentRef.getElementById(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildTokenCss();
  documentRef.head.appendChild(style);
}
