/**
 * MessageBubble.test.tsx —— 消息气泡测试（design.md §5.2 v1.3 + §6.1 v1.5）。
 *
 * 覆盖：
 *  1. 用户消息 attachments → 气泡内嵌附件条（复用 AttachmentStrip）：
 *     image → 缩略图（URL 来自 api.attachmentRawUrl）；file → 名称+大小；
 *  2. 无 attachments / 畸形数组 → 不渲染附件条，不崩溃；
 *  3. v1.5 Markdown 管线：助手正文加粗/表格/公式渲染（不再原样输出星号）；
 *     用户气泡同样走管线；星号原文不再出现在 DOM 文本中。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import { setApi } from '../../api';
import { createFakeApi } from '../../test/fakeApi';
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
    const client = createFakeApi();
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

describe('MessageBubble Markdown 管线（v1.5）', () => {
  it('助手正文：加粗 → strong、表格 → table、公式 → katex（星号井号不外露）', () => {
    render(
      <MessageBubble
        message={{
          ...base,
          id: 'm-2',
          role: 'assistant',
          content:
            '## 收敛结果\n\n**能量** $E_0$ 已收敛：\n\n| 参数 | 值 |\n|---|---|\n| θ₀ | 0.11 |',
        }}
      />,
    );
    const body = document.querySelector('.message--assistant .message__text');
    expect(body).not.toBeNull();
    expect(body?.querySelector('strong')).toHaveTextContent('能量');
    expect(body?.querySelector('table')).not.toBeNull();
    expect(body?.querySelector('.katex')).not.toBeNull();
    expect(body?.querySelector('h2')).toHaveTextContent('收敛结果');
    // 原始 Markdown 语法不再以文本形式出现
    expect(body?.textContent).not.toContain('**能量**');
    expect(body?.textContent).not.toContain('## 收敛结果');
    expect(body?.textContent).not.toContain('|---|---|');
  });

  it('用户气泡同样走 Markdown 管线（加粗渲染为 strong）', () => {
    render(<MessageBubble message={{ ...base, content: '请估算 **H2 基态能量**' }} />);
    const bubble = document.querySelector('.message__bubble');
    expect(bubble?.querySelector('strong')).toHaveTextContent('H2 基态能量');
    expect(bubble?.textContent).not.toContain('**');
  });
});
