/**
 * vite.config.ts —— Vite + Vitest 构建配置。
 *
 * 职责：
 *  - 注册 @vitejs/plugin-react（JSX 转换与快速刷新）；
 *  - dev server 监听 5173（与后端 config.toml 的 CORS 白名单一致）；
 *  - vitest：jsdom 环境 + jest-dom 断言库 + globals。
 *
 * 说明：VITE_USE_MOCK=1 时 src/api/index.ts 切换到内置 Mock，
 * 本文件不做环境分支。
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
