/**
 * api/index.ts —— API 接入点：按 VITE_USE_MOCK 选择真实后端或 Mock 引擎。
 *
 * 用法：
 *  - `npm run dev`（默认）→ RestClient → http://127.0.0.1:8000；
 *  - `VITE_USE_MOCK=1 npm run dev` → createMockClient()（内置 fixtures + 脚本流）。
 * 测试可通过 setApi() 注入自定义实例（store 在调用时解析，不缓存旧引用）。
 */
import { RestClient, type ApiClient } from './client';
import { createMockClient } from './mock/engine';

let instance: ApiClient | null = null;

/** 当前 API 实例（懒初始化，保证 VITE_USE_MOCK 在读取时已生效）。 */
export function getApi(): ApiClient {
  if (instance === null) {
    instance =
      import.meta.env.VITE_USE_MOCK === '1'
        ? createMockClient()
        : // v1.3：默认同源（Vite dev 代理 /api → 127.0.0.1:8000；生产同域
          // 部署或经反代）。VITE_API_BASE 可显式覆盖为绝对地址。
          new RestClient(
            (import.meta.env.VITE_API_BASE as string | undefined) ?? '',
          );
  }
  return instance;
}

/** 覆盖 API 实例（测试注入 / 热切换）。 */
export function setApi(client: ApiClient): void {
  instance = client;
}
