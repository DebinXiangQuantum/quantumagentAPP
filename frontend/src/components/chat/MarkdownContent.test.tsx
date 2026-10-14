/**
 * MarkdownContent.test.tsx —— Markdown/公式/表格渲染管线测试（design.md §6.1 v1.5）。
 *
 * 覆盖（用户反馈三类缺陷：Markdown 原样输出 / 公式不渲染 / 表格不渲染）：
 *  1. GFM 表格：th/td 列内容渲染 + 横向滚动容器（md-table-wrap）；
 *  2. 数学公式：行内 `$…$` 产出 .katex 节点；块级 `$$…$$` 产出 .katex-display；
 *  3. 代码块：md-codeblock 类名 + mono 类；行内 code 保留；
 *  4. 标题层级映射（h1/h2 文本）与引用块；
 *  5. 链接色 token：chat.css 中 .md-body a 绑定 var(--accent-cyan)；
 *  6. 流式健壮性：截断表格 / 未闭合公式 / 半截标题渲染不抛异常；
 *  7. 安全：raw HTML 默认禁用（<b>/<script> 不产出对应元素）；
 *  8. 畸形 props（非字符串 content）降级为空，不崩溃。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// 样式源文本：断言 token 绑定（css:false 不注入样式，源文本直接读文件校验；
// vitest cwd = frontend/）
const chatCss = readFileSync(join(process.cwd(), 'src/styles/chat.css'), 'utf-8');
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent 管线（v1.5）', () => {
  it('GFM 表格：表头/单元格内容渲染，置于横向滚动容器', () => {
    render(
      <MarkdownContent
        content={'| 参数 | 最优值 |\n|---|---|\n| θ₀ | 0.11 |\n| θ₁ | 0.23 |'}
      />,
    );
    const wrap = document.querySelector('.md-body .md-table-wrap');
    expect(wrap).not.toBeNull();
    const table = wrap?.querySelector('table') ?? null;
    expect(table).not.toBeNull();
    expect(screen.getByText('参数')).toBeInTheDocument();
    expect(screen.getByText('θ₀')).toBeInTheDocument();
    expect(screen.getByText('0.23')).toBeInTheDocument();
  });

  it('行内公式 $…$ 产出 KaTeX 节点（katex 类）', () => {
    render(<MarkdownContent content={'能量 $E_0 \\approx -1.1373\\,\\mathrm{Ha}$ 收敛。'} />);
    expect(document.querySelector('.md-body .katex')).not.toBeNull();
    expect(screen.getByText(/收敛/)).toBeInTheDocument();
  });

  it('块级公式 $$…$$ 产出 katex-display 节点（单行段与围栏两种写法）', () => {
    const { unmount } = render(
      <MarkdownContent content={'前文\n\n$$E(\\theta)=\\langle\\psi|\\hat H|\\psi\\rangle$$\n\n后文'} />,
    );
    expect(document.querySelector('.md-body .katex-display .katex')).not.toBeNull();
    expect(screen.getByText(/前文/)).toBeInTheDocument();
    unmount();
    render(<MarkdownContent content={'$$\nE = mc^2\n$$'} />);
    expect(document.querySelector('.md-body .katex-display .katex')).not.toBeNull();
  });

  it('代码块：md-codeblock + mono 类名；行内 code 保留文本', () => {
    render(<MarkdownContent content={'运行 `qc.run()`：\n\n```python\nprint(42)\n```'} />);
    const pre = document.querySelector('.md-body pre');
    expect(pre?.className).toContain('md-codeblock');
    expect(pre?.className).toContain('mono');
    expect(screen.getByText('qc.run()').tagName).toBe('CODE');
    expect(pre).toHaveTextContent('print(42)');
  });

  it('标题层级与引用块渲染（h1/h2/blockquote）', () => {
    render(<MarkdownContent content={'# 能量收敛\n\n## 参数表\n\n> 后端已拒绝非法线路。'} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('能量收敛');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('参数表');
    expect(screen.getByText('后端已拒绝非法线路。').closest('blockquote')).not.toBeNull();
  });

  it('链接样式绑定 accent-cyan token（样式源断言）', () => {
    render(<MarkdownContent content={'[文档](https://example.com)'} />);
    const link = screen.getByRole('link', { name: '文档' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    // token 化约束：.md-body a 颜色必须走 var(--accent-cyan)
    expect(chatCss).toMatch(/\.md-body a\s*\{[^}]*color:\s*var\(--accent-cyan\)/);
    // 代码块/表格 token 绑定同步锁定（--bg-inset/边框/表头/行 hover）
    expect(chatCss).toMatch(
      /\.md-body pre\.md-codeblock\s*\{[^}]*background:\s*var\(--bg-inset\)/,
    );
    expect(chatCss).toMatch(/\.md-body th\s*\{[^}]*background:\s*var\(--bg-inset\)/);
    expect(chatCss).toMatch(/\.md-body tr:hover td\s*\{[^}]*background:\s*var\(--bg-elevated\)/);
    expect(chatCss).toMatch(
      /\.md-body blockquote\s*\{[^}]*border-left[^}]*var\(--border-strong\)/,
    );
  });

  it('流式截断内容不崩溃：半截表格 / 未闭合公式 / 半截代码围栏', () => {
    expect(() =>
      render(<MarkdownContent content={'| 参数 | 值 |\n|---|---|\n| θ₀'} />),
    ).not.toThrow();
    expect(() =>
      render(<MarkdownContent content={'收敛至 $$E_0 \\approx -1.1373'} />),
    ).not.toThrow();
    expect(() =>
      render(<MarkdownContent content={'```python\nprint(42)'} />),
    ).not.toThrow();
    expect(document.querySelector('.md-body')).not.toBeNull();
  });

  it('raw HTML 默认禁用：<b>/<script> 不产出元素', () => {
    render(
      <MarkdownContent
        content={'加粗<b>强 HTML</b>注入<script>alert(1)</script>结束'}
      />,
    );
    expect(document.querySelector('.md-body b')).toBeNull();
    expect(document.querySelector('.md-body script')).toBeNull();
    expect(document.querySelector('.md-body strong')).toBeNull();
  });

  it('空内容 / 畸形 content 降级为空容器，不崩溃', () => {
    const { container } = render(<MarkdownContent content={''} />);
    expect(container.querySelector('.md-body')).toBeInTheDocument();
    expect(() =>
      render(<MarkdownContent content={undefined as unknown as string} />),
    ).not.toThrow();
  });

  it('KaTeX 输出配色走 CSS 变量（三主题适配的样式源断言）', () => {
    render(<MarkdownContent content={'$E_0$'} />);
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(chatCss).toMatch(/\.md-body \.katex\s*\{[^}]*color:\s*var\(--text-primary\)/);
    expect(chatCss).toMatch(/\.md-body \.katex-display\s*\{/);
  });
});
