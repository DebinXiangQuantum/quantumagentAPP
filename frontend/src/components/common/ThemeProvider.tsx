/**
 * ThemeProvider.tsx —— 主题挂载组件（design.md §2.1：`<html data-theme="…">` 切换）。
 *
 * 职责：
 *  - 订阅 uiStore.theme，把当前主题写到 document.documentElement 的
 *    data-theme 属性——tokens.ts 注入的 `[data-theme="light"|"sepia"]`
 *    覆盖块随之生效，颜色 token 全局切换（SVG 可视化同样天然生效）；
 *  - 作为壳层组件包裹应用（主题变更 → 全树颜色即时重绘，无需逐组件传参）。
 * Props 契约：{ children?: ReactNode }。
 * 失败行为：无 document 环境（SSR）跳过副作用，不抛异常。
 */
import { useEffect, type ReactNode } from 'react';
import { applyThemeToDocument, useUiStore } from '../../store/uiStore';

export function ThemeProvider(props: { children?: ReactNode }): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);
  return <>{props.children}</>;
}
