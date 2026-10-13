/**
 * main.tsx —— 应用入口。
 *
 * 职责：
 *  1. 注入设计 token（:root CSS 变量，单一来源 tokens.ts）；
 *  2. 导入全局基础样式与布局样式；
 *  3. 挂载 <App /> 到 #root。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { injectTokenStyles } from './styles/tokens';
import './styles/global.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/viz.css';
import { App } from './App';

injectTokenStyles(document);

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点（index.html 被破坏）');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
