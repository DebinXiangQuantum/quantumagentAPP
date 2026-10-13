/**
 * App.tsx —— 根组件。
 *
 * 职责：挂载时触发一次数据 bootstrap（REST + SSE 订阅），渲染应用外壳。
 * 失败行为：bootstrap 失败由各面板的空态/错误态呈现（store.bootError）。
 */
import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { useAppStore } from './store/appStore';

export function App(): JSX.Element {
  useEffect(() => {
    void useAppStore.getState().bootstrap();
  }, []);
  return <AppShell />;
}
