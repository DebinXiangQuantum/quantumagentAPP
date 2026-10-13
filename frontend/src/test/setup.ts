/**
 * setup.ts —— Vitest 全局 setup。
 *
 * 职责：注册 @testing-library/jest-dom 的 vitest 版匹配器
 *      （toBeInTheDocument / toHaveAttribute 等），并为每个用例注入
 *      设计 token 的 <style>（与 main.tsx 行为一致，保证 var() 可解析环境尽量接近真实）。
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { injectTokenStyles } from '../styles/tokens';

injectTokenStyles(document);

// RTL 自动卸载：避免用例间 DOM 泄漏（jsdom 无真实导航）。
afterEach(() => {
  cleanup();
});
