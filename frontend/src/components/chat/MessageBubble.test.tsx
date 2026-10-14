/**
 * MessageBubble.test.tsx —— 消息气泡附件条内嵌测试（design.md §5.2 v1.3）。
 *
 * 覆盖：
 *  1. 用户消息 attachments → 气泡内嵌附件条（复用 AttachmentStrip）：
 *     image → 缩略图（URL 来自 api.attachmentRawUrl）；file → 名称+大小；
 *  2. 无 attachments / 畸形数组 → 不渲染附件条，不崩溃。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import { setApi } from '../../api';
import { createMockClient } from '../../api/mock/engine';
import type { Message } from '../../types/domain';

const base: Message = {
  id: 'm-1',
  conversation_id: 'c-1',
  role: 'user',
  content: '请分析附件',
  agent_id: 'orchestrator',
  artifacts: [],
  created_at: '2026-10-13T09:00:00Z',
};

describe('MessageBubble 附件条（v1.3）', () => {
  it('用户消息内嵌附件条：file 卡（名称+大小）与 image 缩略图', () => {
    const client = createMockClient();
    setApi(client);
    render(
      <MessageBubble
        message={{
          ...base,
          attachments: [
            { id: 'att-1', name: '数据.csv', mime: 'text/csv', size: 2048, kind: 'text' },
            { id: 'att-2', name: 'plot.png', mime: 'image/png', size: 4096, kind: 'image' },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('attachment-att-1')).toHaveTextContent('2.0 KB');
    expect(screen.getByTestId('attachment-att-2')).toBeInTheDocument();
    // 只读：消息气泡内无移除按钮
    expect(screen.queryByTestId('attachment-remove-att-1')).toBeNull();
    client.dispose();
  });

  it('无附件 / 畸形数组 → 不渲染附件条', () => {
    const { rerender } = render(<MessageBubble message={base} />);
    expect(screen.queryByTestId(/^attachment-/)).toBeNull();
    rerender(<MessageBubble message={{ ...base, attachments: 'broken' as never }} />);
    expect(screen.queryByTestId(/^attachment-/)).toBeNull();
  });
});
