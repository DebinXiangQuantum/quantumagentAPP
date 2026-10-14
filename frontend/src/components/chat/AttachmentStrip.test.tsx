/**
 * AttachmentStrip.test.tsx —— 附件条组件测试（design.md §5.2 v1.3）。
 *
 * 覆盖：
 *  1. image 附件 → 缩略图（img src=预览 URL，alt 含文件名）；
 *  2. text/file 附件 → 文件卡（名称 title=完整名 + formatBytes 大小）；
 *  3. onRemove 提供时渲染 × 按钮（点击回调带 id）；未提供（消息气泡只读）
 *     不渲染移除按钮。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentStrip } from './AttachmentStrip';
import type { AttachmentMeta } from '../../types/domain';

const att = (partial: Partial<AttachmentMeta> & { id: string }): AttachmentMeta => ({
  name: partial.name ?? partial.id,
  mime: 'application/octet-stream',
  size: 1024,
  kind: 'file',
  ...partial,
});

describe('AttachmentStrip', () => {
  it('image 附件渲染缩略图（alt 含文件名）', () => {
    render(
      <AttachmentStrip
        items={[att({ id: 'att-1', name: 'plot.png', kind: 'image', mime: 'image/png' })]}
        imageUrls={{ 'att-1': 'blob:preview-1' }}
      />,
    );
    const img = screen.getByAltText(/plot\.png/) as HTMLImageElement;
    expect(img.src).toBe('blob:preview-1');
  });

  it('file/text 附件渲染文件卡：完整名 title + formatBytes 大小', () => {
    render(
      <AttachmentStrip
        items={[
          att({ id: 'att-2', name: '实验数据导出.csv', kind: 'text', mime: 'text/csv', size: 1536 }),
          att({ id: 'att-3', name: 'state.bin', kind: 'file', size: 8 * 1024 * 1024 }),
        ]}
      />,
    );
    const card2 = screen.getByTestId('attachment-att-2');
    expect(card2).toHaveTextContent('实验数据导出.csv');
    expect(card2).toHaveTextContent('1.5 KB');
    expect(card2.title).toBe('实验数据导出.csv');
    expect(screen.getByTestId('attachment-att-3')).toHaveTextContent('8.0 MB');
  });

  it('× 移除：仅 onRemove 提供时渲染，点击回调带附件 id', () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <AttachmentStrip items={[att({ id: 'att-4', name: 'a.md', kind: 'text' })]} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByTestId('attachment-remove-att-4'));
    expect(onRemove).toHaveBeenCalledWith('att-4');
    // 只读模式（消息气泡）：不渲染移除按钮
    rerender(<AttachmentStrip items={[att({ id: 'att-4', name: 'a.md', kind: 'text' })]} />);
    expect(screen.queryByTestId('attachment-remove-att-4')).toBeNull();
  });
});
