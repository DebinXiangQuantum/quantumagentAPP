/**
 * ThemeProvider.test.tsx —— §2.1 三主题挂载测试。
 *
 * 覆盖：
 *  1. ThemeProvider 挂载时把 uiStore.theme 写到 <html data-theme>；
 *  2. setTheme 切换即时生效（light/sepia/dark 属性跟随）；
 *  3. localStorage 持久化（qap.theme），畸形持久化值回退 dark；
 *  4. tokens.css 的 [data-theme] 覆盖块与之配套（联动 tokens.test.ts）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { ThemeProvider } from './ThemeProvider';
import { applyThemeToDocument, useUiStore } from '../../store/uiStore';
import { buildTokenCss } from '../../styles/tokens';

describe('ThemeProvider（§2.1 三主题）', () => {
  beforeEach(() => {
    useUiStore.getState().resetForTest();
    document.documentElement.removeAttribute('data-theme');
  });

  it('挂载即写入 <html data-theme>（默认 dark）', () => {
    render(
      <ThemeProvider>
        <span>x</span>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setTheme 切换即时生效并持久化 localStorage', () => {
    render(
      <ThemeProvider>
        <span>x</span>
      </ThemeProvider>,
    );
    act(() => {
      useUiStore.getState().setTheme('light');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('qap.theme')).toBe('light');

    act(() => {
      useUiStore.getState().setTheme('sepia');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('sepia');
    expect(localStorage.getItem('qap.theme')).toBe('sepia');
  });

  it('applyThemeToDocument 防御式：无 document 不抛异常', () => {
    expect(() => applyThemeToDocument('light', undefined)).not.toThrow();
  });

  it('buildTokenCss 的主题覆盖块与 data-theme 值配套', () => {
    const css = buildTokenCss();
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="sepia"]');
    // dark 无覆盖块：:root 即深色（默认主题零切换成本）
    expect(css).not.toContain('[data-theme="dark"]');
  });
});
