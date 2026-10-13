/**
 * admin.test.ts —— Mock 引擎 v1.1 管理平台与编排链路契约测试
 * （ARCHITECTURE §5 admin API / §8 插件 / §7 reasoning / §10 编排演示）。
 *
 * 覆盖：
 *  1. admin models fixtures 契约：glm-5.3/glm-5.3-flash/mock 渠道 +
 *     default_thinking；PUT 新建/编辑（api_key_inline 只体现 has_api_key，
 *     响应永不回显密钥）；非法 provider/default_thinking → 422；
 *     DELETE 基底渠道 409 / 本地覆盖渠道可删 / 未知 404；
 *  2. plugins：列表含 builtin+installed+broken 示例；安装（source_path，
 *     重名 409，空路径 422）；启停 PUT；卸载 builtin 409、installed 可卸载；
 *  3. 编排流（§10 v1.1）：文本启发式 dispatch——校准请求 → waveform
 *     artifact；回显请求 → 无 artifact；思考增量先于正文；thinking=off
 *     无 reasoning 事件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from './engine';
import { ApiError } from '../client';
import type { ConversationStreamEvent } from '../../types/events';
import type { ModelChannelInput } from '../../types/domain';

function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

describe('admin models（渠道池）', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });
  afterEach(() => {
    client.dispose();
  });

  it('fixtures 契约：glm-5.3 / glm-5.3-flash / mock 渠道 + default_thinking', async () => {
    const { models } = await client.listAdminModels();
    const refs = models.map((c) => c.ref).sort();
    expect(refs).toEqual(['glm-5.3', 'glm-5.3-flash', 'mock']);
    const byRef = Object.fromEntries(models.map((c) => [c.ref, c]));
    expect(byRef['glm-5.3']).toMatchObject({
      provider: 'openai',
      model: 'glm-5.3',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key_env: 'GLM_API_KEY',
      has_api_key: true,
      default_thinking: 'max',
    });
    expect(byRef['glm-5.3-flash'].default_thinking).toBe('high');
    expect(byRef['glm-5.3-flash'].has_api_key).toBe(false); // 演示"密钥未设置"
    expect(byRef.mock).toMatchObject({ provider: 'mock', default_thinking: 'high' });
  });

  it('PUT：api_key_inline 只体现为 has_api_key=true，响应永不回显密钥', async () => {
    const created = await client.putAdminModel({
      ref: 'glm-4.7',
      provider: 'openai',
      model: 'glm-4.7',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key_env: 'GLM_API_KEY',
      default_thinking: 'low',
      timeout_seconds: 60,
      api_key_inline: 'sk-secret-never-echo',
    });
    expect(created.has_api_key).toBe(true);
    expect(JSON.stringify(created)).not.toContain('sk-secret-never-echo');
    // 再 GET：同样只有 has_api_key，无密钥材料
    const { models } = await client.listAdminModels();
    const saved = models.find((c) => c.ref === 'glm-4.7');
    expect(saved?.has_api_key).toBe(true);
    expect(JSON.stringify(models)).not.toContain('sk-secret');
    // 编辑不填 inline：has_api_key 保持
    const updated = await client.putAdminModel({ ...created, api_key_inline: undefined });
    expect(updated.has_api_key).toBe(true);
  });

  it('PUT 非法 provider / default_thinking → 422', async () => {
    const base: ModelChannelInput = {
      ref: 'bad-1',
      provider: 'openai',
      model: 'm',
      base_url: '',
      api_key_env: '',
      default_thinking: 'high',
      timeout_seconds: 30,
    };
    const err1 = await client
      .putAdminModel({ ...base, provider: 'gemini' as ModelChannelInput['provider'] })
      .catch((e: unknown) => e);
    expect(isApiError(err1) && err1.status).toBe(422);
    const err2 = await client
      .putAdminModel({ ...base, default_thinking: 'ultra' as ModelChannelInput['default_thinking'] })
      .catch((e: unknown) => e);
    expect(isApiError(err2) && err2.status).toBe(422);
  });

  it('DELETE：基底渠道 409；本地覆盖渠道可删；未知 404', async () => {
    const errBase = await client.deleteAdminModel('glm-5.3').catch((e: unknown) => e);
    expect(isApiError(errBase) && errBase.status).toBe(409);

    await client.putAdminModel({
      ref: 'temp-channel',
      provider: 'mock',
      model: 'm',
      base_url: '',
      api_key_env: '',
      default_thinking: 'off',
      timeout_seconds: 10,
    });
    await expect(client.deleteAdminModel('temp-channel')).resolves.toBeUndefined();
    const errGone = await client.deleteAdminModel('temp-channel').catch((e: unknown) => e);
    expect(isApiError(errGone) && errGone.status).toBe(404);
  });
});

describe('admin plugins（插件管理）', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });
  afterEach(() => {
    client.dispose();
  });

  it('列表：builtin + installed + broken 原因（fixtures 契约）', async () => {
    const { plugins } = await client.listAdminPlugins();
    expect(plugins.map((p) => p.id)).toContain('algorithm-designer');
    const installed = plugins.filter((p) => p.source === 'installed');
    expect(installed.length).toBeGreaterThanOrEqual(2);
    const broken = plugins.find((p) => p.id === 'legacy-noise-model');
    expect(broken?.broken_reason).toBeTruthy();
    expect(broken?.broken_reason).toContain('plugin.json');
  });

  it('安装：source_path 目录名成为插件 id；重名 409；空路径 422', async () => {
    const info = await client.installPlugin({ source_path: './vendor/ftqe-analyzer' });
    expect(info.id).toBe('ftqe-analyzer');
    expect(info.source).toBe('installed');
    expect(info.enabled).toBe(true);
    const dup = await client
      .installPlugin({ source_path: '/any/ftqe-analyzer' })
      .catch((e: unknown) => e);
    expect(isApiError(dup) && dup.status).toBe(409);
    const empty = await client.installPlugin({ source_path: '  ' }).catch((e: unknown) => e);
    expect(isApiError(empty) && empty.status).toBe(422);
  });

  it('启停：PUT enabled 持久于内存列表；未知插件 404', async () => {
    const off = await client.setPluginEnabled('echo', false);
    expect(off.enabled).toBe(false);
    const { plugins } = await client.listAdminPlugins();
    expect(plugins.find((p) => p.id === 'echo')?.enabled).toBe(false);
    const err = await client.setPluginEnabled('nope', true).catch((e: unknown) => e);
    expect(isApiError(err) && err.status).toBe(404);
  });

  it('卸载：builtin 409；installed 可卸载', async () => {
    const err = await client.uninstallPlugin('calibration').catch((e: unknown) => e);
    expect(isApiError(err) && err.status).toBe(409);
    await expect(client.uninstallPlugin('pulse-seq-compiler')).resolves.toBeUndefined();
    const { plugins } = await client.listAdminPlugins();
    expect(plugins.find((p) => p.id === 'pulse-seq-compiler')).toBeUndefined();
  });
});

describe('编排流（orchestrator dispatch，§10 v1.1）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function collect(client: ReturnType<typeof createMockClient>, text: string, thinking?: 'off' | 'high'): ConversationStreamEvent[] {
    const events: ConversationStreamEvent[] = [];
    client.openConversationStream('c-1', null, { onEvent: (e) => events.push(e) });
    void client.sendMessage('c-1', text, thinking ? { thinking_level: thinking } : undefined);
    vi.advanceTimersByTime(20_000);
    return events;
  }

  it('校准请求 → dispatch calibration → waveform artifact', () => {
    const client = createMockClient();
    const events = collect(client, '对 Q0 做一次 X π 脉冲校准');
    const completed = events.find((e) => e.event === 'message.completed');
    expect(completed).toBeDefined();
    if (completed && completed.event === 'message.completed') {
      expect(completed.data.artifacts.map((a) => a.type)).toEqual(['waveform']);
      expect(completed.data.reasoning).toContain('calibration');
    }
    client.dispose();
  });

  it('回显请求 → dispatch echo → 无 artifact', () => {
    const client = createMockClient();
    const events = collect(client, '冒烟回显测试');
    const completed = events.find(
      (e): e is Extract<ConversationStreamEvent, { event: 'message.completed' }> =>
        e.event === 'message.completed',
    );
    expect(completed).toBeDefined();
    expect(completed!.data.artifacts).toEqual([]);
    client.dispose();
  });

  it('thinking=off：无 reasoning 事件；默认（high）：reasoning 先于正文且 seq 单调', () => {
    const client = createMockClient();
    const off = collect(client, '请设计 VQE 线路', 'off');
    expect(off.filter((e) => e.event === 'message.reasoning')).toHaveLength(0);
    expect(off.some((e) => e.event === 'message.delta')).toBe(true);

    const on = collect(client, '请设计 VQE 线路');
    const firstReasoning = on.findIndex((e) => e.event === 'message.reasoning');
    const firstDelta = on.findIndex((e) => e.event === 'message.delta');
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstDelta);
    const seqs = on
      .filter(
        (e): e is Extract<ConversationStreamEvent, { event: 'message.reasoning' | 'message.delta' }> =>
          e.event === 'message.reasoning' || e.event === 'message.delta',
      )
      .map((e) => e.data.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    client.dispose();
  });
});
