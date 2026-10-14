/**
 * vite-env.d.ts —— 测试专用最小环境声明（项目未引入 @types/node）。
 *
 *  - `node:fs`：SettingsPage.test.tsx 读取 settings.css 源码做静态规则
 *    断言（vitest 运行于 node；仅声明用到的 readFileSync 形状）。
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
}
