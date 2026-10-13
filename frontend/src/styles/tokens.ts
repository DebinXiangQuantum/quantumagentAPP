/**
 * tokens.ts —— QuantumAgentApp 前端设计系统的**唯一来源**（design.md §2–§4、§5、§7）。
 *
 * 职责：
 *  - 以 TypeScript 常量定义全部颜色/字体/字号/间距/圆角/阴影/z-index/动效/布局尺寸；
 *  - `buildTokenCss()` 将其编译为 `:root { --* }` CSS 变量块，由 main.tsx 注入
 *    （保证 CSS 与 TS 永远同源，杜绝手抄漂移）；
 *  - SVG 等需要具体几何数值的场景引用 `TOKENS`（如线路格点 44×36），
 *    组件中**禁止**出现任何未走 token 的颜色/字号/间距字面量。
 *
 * 失败行为：本模块为纯常量，无运行时失败路径；测试逐字校验与 design.md 一致。
 */

/** §2 色板（深空暗色主题）。键名与 CSS 变量一一对应（camelCase ↔ kebab-case）。 */
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
  },
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
  /** §4 双层低饱和阴影。 */
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

/** token 的 CSS 变量名（不含前缀 `--`）与值。生成 :root 块与测试均以此为权威清单。 */
export const CSS_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  // —— §2 色板 ——
  ['bg-base', TOKENS.color.bgBase],
  ['bg-surface', TOKENS.color.bgSurface],
  ['bg-elevated', TOKENS.color.bgElevated],
  ['bg-inset', TOKENS.color.bgInset],
  ['border-default', TOKENS.color.borderDefault],
  ['border-strong', TOKENS.color.borderStrong],
  ['text-primary', TOKENS.color.textPrimary],
  ['text-secondary', TOKENS.color.textSecondary],
  ['text-faint', TOKENS.color.textFaint],
  ['accent-cyan', TOKENS.color.accentCyan],
  ['accent-violet', TOKENS.color.accentViolet],
  ['success', TOKENS.color.success],
  ['warning', TOKENS.color.warning],
  ['danger', TOKENS.color.danger],
  ['info', TOKENS.color.info],
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

/**
 * 生成 `:root{--token:value;…}` CSS 文本（紧凑单行，main.tsx 以 <style> 注入）。
 * 假设：仅在应用启动时调用一次；变量名与值均为受控字面量，无需转义。
 */
export function buildTokenCss(): string {
  const body = CSS_VARIABLES.map(([name, value]) => `--${name}:${value}`).join(';');
  return `:root{${body}}`;
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
