/**
 * client.test.ts —— REST/SSE 客户端纯逻辑测试（不发真实网络请求）。
 *
 * 覆盖：
 *  1. 指数退避 nextBackoffMs：1s 起步、×2 增长、30s 封顶（§7 断线重连上限）；
 *  2. 流 URL 构建：/api/v1 前缀 + ?after= 断线续传参数；
 *  3. REST 请求携带 Authorization: Bearer 与 JSON 头；
 *  4. 非 2xx 抛出带状态码的 ApiError（401/404/429 语义）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, nextBackoffMs, RestClient, buildStreamUrl } from './client';

describe('SSE 断线重连退避', () => {
  it('1s 起步、指数增长、30s 封顶', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(nextBackoffMs(4)).toBe(16000);
    expect(nextBackoffMs(5)).toBe(30000); // 32s 被封顶
    expect(nextBackoffMs(9)).toBe(30000);
    expect(nextBackoffMs(99)).toBe(30000);
  });
  it('负数/NaN 次数按首次重连处理（1s），不抛异常', () => {
    expect(nextBackoffMs(-3)).toBe(1000);
    expect(Number.isNaN(nextBackoffMs(Number.NaN))).toBe(false);
  });
});

describe('流 URL 构建', () => {
  it('会话流：/api/v1/conversations/{cid}/stream，无 after 时省略参数', () => {
    expect(buildStreamUrl('http://x', 'c-1', null)).toBe(
      'http://x/api/v1/conversations/c-1/stream',
    );
  });
  it('带 after：?after=<eventId> 用于断线续传', () => {
    expect(buildStreamUrl('http://x', 'c-1', 42)).toBe(
      'http://x/api/v1/conversations/c-1/stream?after=42',
    );
  });
});

describe('RestClient 请求头与错误语义', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /agents 携带 Bearer 与 Accept 头', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RestClient('http://backend', 'demo-key');
    await client.listAgents();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/v1/agents');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer demo-key',
    );
  });

  it('401 / 404 / 429 映射为 ApiError（含状态码与 Retry-After 透传）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"detail":"quota"}', {
          status: 429,
          headers: { 'Retry-After': '7' },
        }),
      ) as unknown as typeof fetch,
    );
    const client = new RestClient('http://backend', 'k');
    const err = await client.listAgents().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).retryAfterSeconds).toBe(7);
  });
});
