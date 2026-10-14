/**
 * ComposerAttachments.test.tsx —— composer 附件全流程（design.md §5/§5.2 v1.3）。
 *
 * 覆盖：
 *  1. ＋ → 文件选择 → 无活跃会话先自动建会话 → POST attachments →
 *     预览条出现（图片缩略图 / 文件卡名称+大小；附件 id 由 mock 动态分配，
 *     断言用文件名/大小定位，不写死 id）；
 *  2. × 移除单个附件；
 *  3. 随消息发送：onSend 收到 (text, attachments[])（ChatPanel 将其作为
 *     attachment_ids/attachments 传给 store.sendMessage）；
 *  4. 上传失败内联错误（不吞异常）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageInput } from './MessageInput';
import { useAppStore } from '../../store/appStore';
import { useUiStore } from '../../store/uiStore';
import { createMockClient } from '../../api/mock/engine';
import { setApi } from '../../api';
import { ApiError } from '../../api/client';
import type { AttachmentMeta } from '../../types/domain';

function fileOf(name: string, mime: string, size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: mime });
}

describe('composer 附件全流程（v1.3）', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    setApi(client);
    useUiStore.getState().resetForTest();
    useAppStore.getState().resetForTest();
  });

  it('＋ 选择文件：无会话先自动建会话 → 上传 → 预览条文件卡；随消息发送', async () => {
    useAppStore.setState({ activeConversationId: null, conversations: [] });
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
    expect(input.getAttribute('accept')).toContain('image/*');
    act(() => {
      fireEvent.change(input, { target: { files: [fileOf('ansatz.py', 'text/x-python')] } });
    });
    const card = await waitFor(() => screen.getByTitle('ansatz.py'));
    // 无会话 → 上传前自动建会话
    expect(useAppStore.getState().activeConversationId).not.toBeNull();
    expect(card).toHaveTextContent('2.0 KB');

    // 发送：onSend 收到附件元数据
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '基于附件优化' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, atts] = onSend.mock.calls[0] as [string, AttachmentMeta[]];
    expect(text).toBe('基于附件优化');
    expect(atts.map((a) => a.name)).toEqual(['ansatz.py']);
    // 发送后预览条清空
    expect(screen.queryByTitle('ansatz.py')).toBeNull();
  });

  it('图片附件显示缩略图；× 移除后不再随消息发送', async () => {
    useAppStore.setState({ activeConversationId: 'c-1' });
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);
    act(() => {
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [fileOf('plot.png', 'image/png')] },
      });
    });
    await waitFor(() => expect(screen.getByAltText(/plot\.png/)).toBeInTheDocument());
    const card = screen.getByAltText(/plot\.png/).closest('[data-testid^="attachment-"]')!;
    act(() => {
      fireEvent.click(within(card as HTMLElement).getByTestId(/attachment-remove-/));
    });
    expect(screen.queryByAltText(/plot\.png/)).toBeNull();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '看图' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('看图', []);
  });

  it('上传失败 → 内联错误（422 语义），可继续输入', async () => {
    useAppStore.setState({ activeConversationId: 'c-1' });
    const uploadSpy = vi
      .spyOn(client, 'uploadAttachment')
      .mockRejectedValue(new ApiError(422, '单文件不得超过 8MB', null));
    render(<MessageInput onSend={vi.fn()} />);
    act(() => {
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [fileOf('huge.dat', 'application/octet-stream')] },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('composer-error')).toHaveTextContent('8MB');
    });
    expect(uploadSpy).toHaveBeenCalled();
    client.dispose();
  });
});
