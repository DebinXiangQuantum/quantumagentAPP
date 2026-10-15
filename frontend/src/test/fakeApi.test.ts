/**
 * fakeApi.test.ts —— 测试替身自身的契约测试（v1.6 去 mock 化）。
 *
 * 覆盖：
 *  1. 预置数据服务：全部 GET 面板数据来自 src/test/data.ts 且深拷贝
 *     （消费方改动不回写，测试间互不串改）；404/角色选项语义；
 *  2. 流：emitConversation 自动补 seq 且单调；?after= 重放；emitGlobal 扇出；
 *     sendMessage 脚本按相对延时依序发射（fake timers 驱动）；
 *  3. 附件：kind 判定 / 8MB 上限 / 空文件 422；attachment_ids 落库与
 *     未知 id 422；lastSendCall 记录请求体；
 *  4. 管理端：PUT 校验（provider 仅 openai|anthropic、非法 thinking 422、
 *     api_key_inline 只体现 has_api_key）；DELETE 基底 409 / 本地覆盖可删 /
 *     未知 404；插件安装/启停/卸载（builtin 409）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApiClient } from './fakeApi';
import { ApiError } from '../api/client';
import type { ConversationStreamEvent } from '../types/events';
import type { ModelChannelInput } from '../types/domain';

function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

function makeFile(name: string, mime: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: mime });
}

describe('fakeApi 预置数据与 REST 语义', () => {
  let api: FakeApiClient;
  beforeEach(() => {
    api = createFakeApi();
  });
  afterEach(() => {
    api.dispose();
  });

  it('GET 面板数据齐全：agents/tenant/会话+消息/硬件/任务/渠道/插件', async () => {
    expect((await api.listAgents()).map((a) => a.id)).toContain('algorithm-designer');
    expect((await api.getTenant()).id).toBe('demo');
    const convs = await api.listConversations();
    expect(convs.length).toBeGreaterThanOrEqual(2);
    expect((await api.getConversation(convs[0].id)).messages.length).toBeGreaterThanOrEqual(2);
    expect((await api.listHardware()).nodes.length).toBeGreaterThanOrEqual(4);
    expect((await api.listTasks()).length).toBeGreaterThanOrEqual(2);
    expect((await api.listAdminModels()).models.map((c) => c.ref)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
    ]);
    expect((await api.listSelectorModels()).models.map((c) => c.ref)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
    ]);
    expect((await api.listAdminPlugins()).plugins.length).toBeGreaterThanOrEqual(4);
  });

  it('返回值为深拷贝：消费方改动不回写替身状态', async () => {
    const { nodes } = await api.listHardware();
    const total = nodes.length;
    nodes[0].status = 'offline';
    nodes.pop();
    const again = await api.listHardware();
    expect(again.nodes.length).toBe(total);
    expect(again.nodes[0].status).toBe('online');
  });

  it('租户角色可选项：tenantRole=user 覆盖预置 admin', async () => {
    expect((await createFakeApi({ tenantRole: 'user' }).getTenant()).role).toBe('user');
  });

  it('404 语义：未知会话/任务', async () => {
    const e1 = await api.getConversation('c-nope').catch((e: unknown) => e);
    expect(isApiError(e1) && e1.status).toBe(404);
    const e2 = await api.getTask('t-nope').catch((e: unknown) => e);
    expect(isApiError(e2) && e2.status).toBe(404);
  });

  it('createConversation：缺省 agent_id=orchestrator 且新会话消息为空', async () => {
    const conv = await api.createConversation({ title: '新任务' });
    expect(conv.agent_id).toBe('orchestrator');
    expect((await api.getConversation(conv.id)).messages).toEqual([]);
    expect((await api.listConversations())[0].id).toBe(conv.id);
  });
});

describe('fakeApi 流（seq / 重放 / 脚本）', () => {
  let api: FakeApiClient;
  beforeEach(() => {
    vi.useFakeTimers();
    api = createFakeApi();
  });
  afterEach(() => {
    api.dispose();
    vi.useRealTimers();
  });

  it('emitConversation 自动补 seq 且单调；显式 seq 保留', () => {
    const seen: ConversationStreamEvent[] = [];
    api.openConversationStream('c-1', null, { onEvent: (e) => seen.push(e) });
    api.emitConversation('c-1', {
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-1', delta: 'a' },
    } as never);
    api.emitConversation('c-1', {
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-1', delta: 'b' },
    } as never);
    const seqs = seen.map((e) => (e.event === 'message.delta' ? e.data.seq : 0));
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    api.emitConversation('c-1', {
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-1', delta: 'x', seq: 999 },
    } as never);
    expect(seen[2].event).toBe('message.delta');
    if (seen[2].event === 'message.delta') expect(seen[2].data.seq).toBe(999);
  });

  it('?after= 重放：close 后的事件在重开时按 logSeq 补发', () => {
    const first: ConversationStreamEvent[] = [];
    const handle = api.openConversationStream('c-1', null, { onEvent: (e) => first.push(e) });
    api.emitConversation('c-1', {
      event: 'message.delta',
      data: { conversation_id: 'c-1', message_id: 'm-1', delta: 'a' },
    } as never);
    handle.close();
    const replayed: ConversationStreamEvent[] = [];
    api.openConversationStream('c-1', 1, { onEvent: (e) => replayed.push(e) });
    expect(replayed).toHaveLength(0);
    api.openConversationStream('c-1', 0, { onEvent: (e) => replayed.push(e) });
    expect(replayed).toHaveLength(1);
  });

  it('sendMessage 脚本：相对延时累计调度，依序发射会话与全局事件', async () => {
    api.setSendScript(() => [
      {
        atMs: 100,
        run: (c) =>
          c.emitConversation({
            event: 'message.reasoning',
            data: { conversation_id: c.cid, message_id: c.assistantMessageId, delta: '思考' },
          } as never),
      },
      {
        atMs: 200,
        run: (c) =>
          c.emitGlobal({ event: 'task.updated', data: { task_id: 't-9', status: 'running', steps: [] } }),
      },
      {
        atMs: 300,
        run: (c) =>
          c.emitConversation({
            event: 'message.completed',
            data: { conversation_id: c.cid, message_id: c.assistantMessageId, artifacts: [], reasoning: '思考' },
          } as never),
      },
    ]);
    const conv: ConversationStreamEvent[] = [];
    const global: unknown[] = [];
    api.openConversationStream('c-1', null, { onEvent: (e) => conv.push(e) });
    api.openGlobalStream({ onEvent: (e) => global.push(e) });
    const ack = await api.sendMessage('c-1', '请设计 VQE 线路');
    expect(conv).toHaveLength(0); // 未到延时
    await vi.advanceTimersByTimeAsync(150); // 150ms：仅第一拍（100ms）
    expect(conv.map((e) => e.event)).toEqual(['message.reasoning']);
    await vi.advanceTimersByTimeAsync(200); // 350ms：第二拍（300ms）为全局事件
    expect(conv.map((e) => e.event)).toEqual(['message.reasoning']);
    expect(global).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300); // 650ms：第三拍（600ms）completed
    expect(conv.map((e) => e.event)).toEqual(['message.reasoning', 'message.completed']);
    // ack.message_id 为预创建 assistant id，脚本事件归属一致
    const completed = conv[1];
    if (completed.event === 'message.completed') {
      expect(completed.data.message_id).toBe(ack.message_id);
    }
    // 用户消息已落库
    const detail = await api.getConversation('c-1');
    expect(detail.messages.some((m) => m.role === 'user' && m.content === '请设计 VQE 线路')).toBe(true);
  });

  it('lastSendCall 记录最近一次请求体（断言 model_ref/attachment_ids 用）', async () => {
    await api.sendMessage('c-1', '你好', { model_ref: 'glm-5.3', thinking_level: 'low' });
    expect(api.lastSendCall).toEqual({
      cid: 'c-1',
      content: '你好',
      req: { model_ref: 'glm-5.3', thinking_level: 'low' },
    });
  });
});

describe('fakeApi 附件端点（v1.3 契约）', () => {
  let api: FakeApiClient;
  beforeEach(() => {
    api = createFakeApi();
  });
  afterEach(() => {
    api.dispose();
  });

  it('kind 判定 image / text / file + 元数据回显', async () => {
    const img = await api.uploadAttachment('c-1', makeFile('线路图.png', 'image/png', 2048));
    expect(img.kind).toBe('image');
    expect(img.id).toMatch(/^att-/);
    expect((await api.uploadAttachment('c-1', makeFile('ansatz.py', 'text/x-python', 512))).kind).toBe('text');
    expect((await api.uploadAttachment('c-1', makeFile('README.md', '', 128))).kind).toBe('text');
    expect((await api.uploadAttachment('c-1', makeFile('state.bin', 'application/octet-stream', 64))).kind).toBe('file');
  });

  it('超限（> 8MB）→ 422；恰好 8MB 允许', async () => {
    await expect(
      api.uploadAttachment('c-1', makeFile('huge.dat', 'application/octet-stream', 9 * 1024 * 1024)),
    ).rejects.toMatchObject({ status: 422 });
    const edge = await api.uploadAttachment('c-1', makeFile('edge.dat', 'application/octet-stream', 8 * 1024 * 1024));
    expect(edge.kind).toBe('file');
  });

  it('attachment_ids 落库到用户消息；未知 id → 422；image raw 为 data: URL', async () => {
    const att = await api.uploadAttachment('c-1', makeFile('数据.csv', 'text/csv', 256));
    const img = await api.uploadAttachment('c-1', makeFile('plot.png', 'image/png', 128));
    await api.sendMessage('c-1', '分析附件数据', { attachment_ids: [att.id] });
    const userMsg = (await api.getConversation('c-1')).messages.find(
      (m) => m.role === 'user' && m.content === '分析附件数据',
    );
    expect(userMsg?.attachments?.map((a) => a.id)).toEqual([att.id]);
    await expect(api.sendMessage('c-1', 'x', { attachment_ids: ['att-nope'] })).rejects.toBeInstanceOf(ApiError);
    expect(api.attachmentRawUrl(img.id).startsWith('data:')).toBe(true);
  });
});

describe('fakeApi 管理端（渠道/插件契约语义）', () => {
  let api: FakeApiClient;
  beforeEach(() => {
    api = createFakeApi();
  });
  afterEach(() => {
    api.dispose();
  });

  it('PUT：api_key_inline 只体现 has_api_key，响应永不回显密钥', async () => {
    const created = await api.putAdminModel({
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
    const saved = (await api.listAdminModels()).models.find((c) => c.ref === 'glm-4.7');
    expect(saved?.has_api_key).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('sk-secret');
  });

  it('PUT 非法 provider（含 mock）/ default_thinking → 422', async () => {
    const base: ModelChannelInput = {
      ref: 'bad-1',
      provider: 'openai',
      model: 'm',
      base_url: '',
      api_key_env: '',
      default_thinking: 'high',
      timeout_seconds: 30,
    };
    const e1 = await api
      .putAdminModel({ ...base, provider: 'mock' as ModelChannelInput['provider'] })
      .catch((e: unknown) => e);
    expect(isApiError(e1) && e1.status).toBe(422);
    const e2 = await api
      .putAdminModel({ ...base, default_thinking: 'ultra' as ModelChannelInput['default_thinking'] })
      .catch((e: unknown) => e);
    expect(isApiError(e2) && e2.status).toBe(422);
  });

  it('DELETE：基底 409；本地覆盖可删；未知 404', async () => {
    const eBase = await api.deleteAdminModel('glm-5.3').catch((e: unknown) => e);
    expect(isApiError(eBase) && eBase.status).toBe(409);
    await api.putAdminModel({
      ref: 'temp-channel',
      provider: 'anthropic',
      model: 'm',
      base_url: '',
      api_key_env: '',
      default_thinking: 'off',
      timeout_seconds: 10,
    });
    await expect(api.deleteAdminModel('temp-channel')).resolves.toBeUndefined();
    const eGone = await api.deleteAdminModel('temp-channel').catch((e: unknown) => e);
    expect(isApiError(eGone) && eGone.status).toBe(404);
  });

  it('插件：安装（目录名为 id，重名 409，空路径 422）；启停；卸载 builtin 409', async () => {
    const info = await api.installPlugin({ source_path: './vendor/ftqe-analyzer' });
    expect(info.id).toBe('ftqe-analyzer');
    const dup = await api.installPlugin({ source_path: '/any/ftqe-analyzer' }).catch((e: unknown) => e);
    expect(isApiError(dup) && dup.status).toBe(409);
    const empty = await api.installPlugin({ source_path: '  ' }).catch((e: unknown) => e);
    expect(isApiError(empty) && empty.status).toBe(422);
    expect((await api.setPluginEnabled('echo', false)).enabled).toBe(false);
    const builtin = await api.uninstallPlugin('calibration').catch((e: unknown) => e);
    expect(isApiError(builtin) && builtin.status).toBe(409);
    await expect(api.uninstallPlugin('pulse-seq-compiler')).resolves.toBeUndefined();
  });
});
