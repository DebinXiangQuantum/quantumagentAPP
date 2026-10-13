/**
 * App.tsx —— 根组件。
 *
 * 职责：渲染应用外壳；数据 bootstrap 在 S2 数据切片由 store 接管后在此触发。
 */
import { AppShell } from './components/layout/AppShell';

export function App(): JSX.Element {
  return <AppShell />;
}
