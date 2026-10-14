/**
 * Attachments.test.ts（mock）—— v1.3 附件端点契约测试（ARCHITECTURE §5.2）。
 *
 * 覆盖：
 *  1. uploadAttachment：multipart file → 201 形状 {id,name,mime,size,kind}；
 *     kind 判定（image/* / text 扩展名 / 其余 file）；
 *  2. 单文件 > 8MB → 422（ApiError）；
 *  3. sendMessage 携带 attachment_ids：落库到用户消息（GET 回看可见）；
 *     未知 id → 422；
 *  4. attachmentRawUrl：image 附件可取回可渲染的 data: URL（消息气泡缩略图）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockClient } from './engine';
import { ApiError } from '../client';

function makeFile(name: string, mime: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: mime });
}

describe('Mock 附件端点（v1.3）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uploadAttachment：kind 判定 image / text / file + 元数据回显', async () => {
    const client = createMockClient();
    const img = await client.uploadAttachment('c-1', makeFile('线路图.png', 'image/png', 2048));
    expect(img.kind).toBe('image');
    expect(img.name).toBe('线路图.png');
    expect(img.mime).toBe('image/png');
    expect(img.size).toBe(2048);
    expect(img.id).toMatch(/^att-/);

    const py = await client.uploadAttachment('c-1', makeFile('ansatz.py', 'text/x-python', 512));
    expect(py.kind).toBe('text');
    const md = await client.uploadAttachment('c-1', makeFile('README.md', '', 128));
    expect(md.kind).toBe('text');
    const bin = await client.uploadAttachment('c-1', makeFile('state.bin', 'application/octet-stream', 64));
    expect(bin.kind).toBe('file');
    client.dispose();
  });

  it('超限（> 8MB）→ 422', async () => {
    const client = createMockClient();
    const big = makeFile('huge.dat', 'application/octet-stream', 9 * 1024 * 1024);
    await expect(client.uploadAttachment('c-1', big)).rejects.toMatchObject({
      status: 422,
    });
    // 边界：恰好 8MB 允许
    const edge = makeFile('edge.dat', 'application/octet-stream', 8 * 1024 * 1024);
    const meta = await client.uploadAttachment('c-1', edge);
    expect(meta.kind).toBe('file');
    client.dispose();
  });

  it('sendMessage 携带 attachment_ids → 用户消息落库附件；未知 id → 422', async () => {
    const client = createMockClient();
    const att = await client.uploadAttachment('c-1', makeFile('数据.csv', 'text/csv', 256));
    await client.sendMessage('c-1', '分析附件数据', { attachment_ids: [att.id] });
    const detail = await client.getConversation('c-1');
    const userMsg = detail.messages.find((m) => m.role === 'user' && m.content === '分析附件数据');
    expect(userMsg?.attachments?.map((a) => a.id)).toEqual([att.id]);

    await expect(
      client.sendMessage('c-1', 'x', { attachment_ids: ['att-nope'] }),
    ).rejects.toBeInstanceOf(ApiError);
    client.dispose();
  });

  it('attachmentRawUrl：image → data: URL（气泡缩略图可用）', async () => {
    const client = createMockClient();
    const img = await client.uploadAttachment('c-1', makeFile('plot.png', 'image/png', 128));
    const url = client.attachmentRawUrl(img.id);
    expect(url.startsWith('data:')).toBe(true);
    client.dispose();
  });
});
