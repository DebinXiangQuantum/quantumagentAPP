/**
 * MarkdownContent.tsx —— 消息正文 Markdown 渲染管线（design.md §6.1 v1.5）。
 *
 * 背景（用户反馈）：助手回复的加粗/标题/列表星号井号原样输出、LaTeX 公式与
 * 表格不渲染。本组件把正文经 react-markdown + remark-gfm（表格/删除线/任务
 * 列表）+ remark-math/rehype-katex（行内 `$…$`、块级 `$$…$$`）渲染。
 *
 * 职责与约束：
 *  - 样式全 token 化（chat.css `.md-body` 段）：标题 --fs-*、代码块
 *    mono+--bg-inset+圆角、表格边框 --border-default/表头 --bg-inset/行 hover
 *    --bg-elevated/横向滚动容器、引用左边框 --border-strong、链接 --accent-cyan；
 *    KaTeX 输出配色用 CSS 变量适配三主题（katex.min.css 全局引入）；
 *  - 默认禁 raw HTML（不引入 rehype-raw，react-markdown 对 raw 节点不渲染）；
 *  - 流式健壮性：内部 ErrorBoundary 兜底——部分/截断 Markdown 万一触发渲染
 *    异常时降级为原始文本 pre，且 content 变化后自动重试完整管线；
 *  - memo 化：流式期间同 content 的重渲染零开销。
 * Props 契约：content: string（非字符串降级为空串，绝不抛异常）。
 */
import { Component, memo, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/** 元素覆写：代码块加 md-codeblock/mono 类；表格包横向滚动容器。 */
const MD_COMPONENTS: Components = {
  pre: ({ children, ...rest }) => (
    <pre {...rest} className="md-codeblock mono">
      {children}
    </pre>
  ),
  table: ({ children, ...rest }) => (
    <div className="md-table-wrap">
      <table {...rest}>{children}</table>
    </div>
  ),
};

/**
 * 显示公式归一：独立成段的单行 `$$…$$` 在 remark-math 里是**行内**数学
 * （仅 `$$\n…\n$$` 围栏才是 flow/display 块）。GLM 等模型常输出单行块级
 * 公式，这里统一改写为围栏形式，保证 katex-display 居中块渲染。
 * 非独立段（前后有同行文字）与未闭合（流式半截）内容不动，安全降级。
 */
function normalizeDisplayMath(content: string): string {
  return content.replace(
    /(^|\n)\$\$([^$\n]+)\$\$(?=\n|$)/g,
    (_match, brk: string, body: string) => `${brk}$$\n${body}\n$$`,
  );
}

/** 渲染异常兜底：原始文本 pre（保留内容可读，等宽便于看出未解析语法）。 */
function FallbackBody(props: { content: string }): JSX.Element {
  return <pre className="md-fallback mono">{props.content}</pre>;
}

/**
 * Markdown 错误边界：流式部分 Markdown 不得崩溃（截断表格/未闭合公式等）。
 * content 变化（下一帧流式增量）时清除失败态自动重试——只有连续失败才
 * 停留在原始文本视图。
 */
class MarkdownBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean; prevContent: string }
> {
  state = { failed: false, prevContent: this.props.content };

  static getDerivedStateFromError(): { failed: boolean } | null {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { content: string },
    state: { failed: boolean; prevContent: string },
  ): { failed: boolean; prevContent: string } | null {
    if (props.content !== state.prevContent) {
      return { failed: false, prevContent: props.content };
    }
    return null;
  }

  render(): ReactNode {
    if (this.state.failed) return <FallbackBody content={this.props.content} />;
    return this.props.children;
  }
}

/** Markdown 渲染主体（memo：流式重渲染时同 content 直接复用）。 */
const MarkdownBody = memo(function MarkdownBody(props: { content: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={MD_COMPONENTS}
    >
      {normalizeDisplayMath(props.content)}
    </ReactMarkdown>
  );
});

export const MarkdownContent = memo(function MarkdownContent(props: {
  content: string;
}): JSX.Element {
  const content = typeof props.content === 'string' ? props.content : '';
  return (
    <div className="md-body" data-testid="md-body">
      <MarkdownBoundary content={content}>
        <MarkdownBody content={content} />
      </MarkdownBoundary>
    </div>
  );
});
