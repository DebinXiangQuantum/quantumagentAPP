/**
 * api/index.ts —— API 接入点（v1.6 去 mock 化：恒为真实后端）。
 *
 * - `npm run dev` → RestClient → 同源（Vite 代理 /api → 127.0.0.1:8000；
 *   生产同域部署或经反代）；VITE_API_BASE 可显式覆盖为绝对地址。
 * - 测试通过 setApi() 注入测试替身（src/test/fakeApi.ts）。
 */
import { RestClient, type ApiClient } from './client';

let instance: ApiClient | null = null;

/** 当前 API 实例（懒初始化）。 */
export function getApi(): ApiClient {
  if (instance === null) {
    instance = new RestClient(
      (import.meta.env.VITE_API_BASE as string | undefined) ?? '',
    );
  }
  return instance;
}

/** 覆盖 API 实例（测试注入 / 热切换）。 */
export function setApi(client: ApiClient): void {
  instance = client;
}
