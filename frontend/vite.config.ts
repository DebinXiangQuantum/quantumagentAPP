/**
 * vite.config.ts —— Vite + Vitest 构建配置。
 *
 * 职责：
 *  - 注册 @vitejs/plugin-react（JSX 转换与快速刷新）；
 *  - dev server 监听 5173；"api" 路径同源代理到后端 8000（v1.3：部分内嵌
 *    webview 的跨域 fetch/预检会静默挂起，同源代理彻底规避 CORS）；
 *  - vitest：jsdom 环境 + jest-dom 断言库 + globals。
 *
 * 说明：VITE_USE_MOCK=1 时 src/api/index.ts 切换到内置 Mock，
 * 本文件不做环境分支。
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // v1.5：KaTeX/react-markdown 体积大且低频变化，独立分包利于缓存
        manualChunks: {
          markdown: ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex', 'katex'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 同源转发：页面与 API 同为 localhost:5173，避免跨域 webview 兼容性问题
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
