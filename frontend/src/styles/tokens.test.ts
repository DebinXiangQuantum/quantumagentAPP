/**
 * tokens.test.ts —— 设计系统单一来源的契约测试（design.md §2–§4 逐字对齐）。
 *
 * 覆盖：
 *  1. 色板 15 个 token 值与 §2 表格逐字一致；
 *  2. 字体栈与 §3（用户逐字指定）完全一致；
 *  3. 字号/行高/间距/圆角/阴影/z-index/动效与 §3–§4、§7 一致；
 *  4. buildTokenCss() 生成的 CSS 变量块包含全部变量且无重复。
 */
import { describe, expect, it } from 'vitest';
import { TOKENS, buildTokenCss, CSS_VARIABLES } from './tokens';

describe('design tokens（design.md §2–§4）', () => {
  it('色板：§2 的 16 个颜色 token 逐字一致', () => {
    expect(TOKENS.color).toEqual({
      bgBase: '#0B0E14',
      bgSurface: '#11151F',
      bgElevated: '#161B28',
      bgInset: '#0D1117',
      borderDefault: '#232A3A',
      borderStrong: '#2E3A50',
      textPrimary: '#E8ECF4',
      textSecondary: '#9AA4B8',
      textFaint: '#5C667A',
      accentCyan: '#4FD8EB',
      accentViolet: '#8B7CF6',
      success: '#3DD68C',
      warning: '#F5B455',
      danger: '#F26D6D',
      info: '#5CA8FF',
    });
  });

  it('字体栈：与 §3 用户逐字指定的三个 font-family 完全一致', () => {
    expect(TOKENS.font.ui).toBe(
      '"Microsoft YaHei","微软雅黑","PingFang SC",Arial,"Helvetica Neue",sans-serif',
    );
    expect(TOKENS.font.data).toBe(
      '"JetBrains Mono",Consolas,"SF Mono",Menlo,monospace',
    );
    expect(TOKENS.font.serif).toBe('"Times New Roman",Times,serif');
  });

  it('字号阶仅 5 档且行高符合 §3', () => {
    expect(TOKENS.fontSize).toEqual({
      caption: '12px',
      body: '13px',
      bodyLg: '15px',
      title: '18px',
      display: '22px',
    });
    expect(TOKENS.lineHeight).toEqual({ body: '1.6', data: '1.45', title: '1.3' });
  });

  it('间距为 8px 网格 7 档；圆角/阴影/z-index 符合 §4', () => {
    expect(TOKENS.space).toEqual({
      s4: '4px',
      s8: '8px',
      s12: '12px',
      s16: '16px',
      s24: '24px',
      s32: '32px',
      s48: '48px',
    });
    expect(TOKENS.radius).toEqual({ sm: '6px', md: '10px', lg: '14px' });
    expect(TOKENS.shadow.s1).toBe(
      '0 1px 2px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.03)',
    );
    expect(TOKENS.shadow.s2).toBe(
      '0 8px 24px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04)',
    );
    expect(TOKENS.zIndex).toEqual({ base: 0, sticky: 10, drawer: 100, toast: 200 });
  });

  it('动效时长 ≤200ms 的 UI 过渡 + 指定循环时长（§7）', () => {
    expect(TOKENS.motion.fast).toBe('120ms');
    expect(TOKENS.motion.panel).toBe('200ms');
    expect(TOKENS.motion.easeOut).toBe('cubic-bezier(.2,.7,.3,1)');
    expect(TOKENS.motion.cursorBlink).toBe('530ms');
    expect(TOKENS.motion.shimmer).toBe('1.2s');
    expect(TOKENS.motion.glowBreath).toBe('2s');
    expect(TOKENS.motion.barGrow).toBe('160ms');
  });

  it('布局尺寸：顶栏 56 / 侧栏 264 / 检查器 360 / 对话 820（§5）', () => {
    expect(TOKENS.layout.topbarHeight).toBe('56px');
    expect(TOKENS.layout.sidebarWidth).toBe('264px');
    expect(TOKENS.layout.inspectorWidth).toBe('360px');
    expect(TOKENS.layout.chatMaxWidth).toBe('820px');
  });

  it('buildTokenCss 生成完整 :root 块：变量齐全、无重复、以已知值收尾', () => {
    const css = buildTokenCss();
    expect(css.startsWith(':root{')).toBe(true);
    for (const [name] of CSS_VARIABLES) {
      expect(css).toContain(`--${name}:`);
    }
    const names = CSS_VARIABLES.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    // 抽查关键变量确实写入了生成的 CSS
    expect(css).toContain('--accent-cyan:#4FD8EB');
    expect(css).toContain('--z-toast:200');
    expect(css.endsWith('}')).toBe(true);
  });
});
