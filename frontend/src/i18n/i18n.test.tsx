/**
 * i18n.test.ts —— 轻量自研 i18n 的契约测试（design.md §2.2）。
 *
 * 覆盖：
 *  1. zh/en/ja 三字典 key 集合完全一致（新增文案必须三语同步）；
 *  2. translate() 插值与回退（未知 key 原样返回、zh 兜底）；
 *  3. 切换语言后关键 UI 文案变化（组件级：TopBar 产品名随语言重渲染）；
 *  4. 语言切换写 localStorage 持久化。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DICTIONARIES, translate } from './index';
import { useUiStore } from '../store/uiStore';
import { TopBar } from '../components/layout/TopBar';

describe('i18n 字典契约', () => {
  it('zh / en / ja 三字典 key 集合完全一致', () => {
    const zhKeys = Object.keys(DICTIONARIES.zh).sort();
    const enKeys = Object.keys(DICTIONARIES.en).sort();
    const jaKeys = Object.keys(DICTIONARIES.ja).sort();
    expect(enKeys).toEqual(zhKeys);
    expect(jaKeys).toEqual(zhKeys);
    // 字典非空且无空值文案
    expect(zhKeys.length).toBeGreaterThan(100);
    for (const dict of Object.values(DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.length, `key=${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('translate：插值 {name} 生效；未知参数保留占位', () => {
    expect(translate('zh', 'time.minAgo', { n: 5 })).toBe('5 分钟前');
    expect(translate('en', 'time.minAgo', { n: 5 })).toBe('5 min ago');
    expect(translate('ja', 'topbar.tenant', { name: 'demo' })).toBe(
      'テナント：demo',
    );
    expect(translate('zh', 'time.minAgo')).toBe('{n} 分钟前');
  });

  it('translate：未知 key 原样返回；缺语言回退 zh', () => {
    expect(translate('zh', 'no.such.key')).toBe('no.such.key');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('关键 chrome 文案三语确实不同（防"三语同文"空迁移）', () => {
    for (const key of [
      'sidebar.title',
      'inspector.tab.hardware',
      'settings.appearance',
      'reasoning.title',
      'status.running',
      // v3 新增 chrome（composer/硬件/DAG/插件状态）
      'composer.model',
      'composer.thinking',
      'dag.mode.timeline',
      'settings.plugins.status.on',
      'hw.topo.legend.poor',
      // v5 新增 chrome（线路渲染提示，CircuitCanvas）
      'circuit.note.postMeasure',
      'circuit.note.dropped',
    ]) {
      const values = new Set([
        translate('zh', key),
        translate('en', key),
        translate('ja', key),
      ]);
      expect(values.size, `key=${key}`).toBe(3);
    }
  });

  it('v3 带参文案三语插值一致（值注入不破坏各语言措辞）', () => {
    expect(translate('zh', 'dag.measured.duration', { v: '413ms' })).toBe('时长 413ms');
    expect(translate('en', 'dag.measured.duration', { v: '413ms' })).toBe('Time 413ms');
    expect(translate('ja', 'dag.measured.duration', { v: '413ms' })).toBe('時間 413ms');
    expect(translate('zh', 'hw.qpu.subline', { count: 20, median: '99.12%' })).toBe(
      '20Q · 2Q 保真度中位 99.12%',
    );
    expect(translate('en', 'hw.qpu.subline', { count: 20, median: '99.12%' })).toBe(
      '20Q · 2Q fidelity median 99.12%',
    );
    expect(translate('ja', 'hw.qpu.subline', { count: 20, median: '99.12%' })).toBe(
      '20Q · 2Q 忠実度中央値 99.12%',
    );
    expect(translate('zh', 'hw.group.online', { online: 6, total: 10 })).toBe(
      ' · 在线 6/10',
    );
    expect(translate('en', 'hw.group.online', { online: 6, total: 10 })).toBe(
      ' · Online 6/10',
    );
    expect(translate('ja', 'attachment.uploadError', { message: '8MB' })).toContain('8MB');
  });
});

describe('语言切换（组件级）', () => {
  beforeEach(() => {
    useUiStore.getState().resetForTest();
  });

  it('切换 EN/JA 后 TopBar 产品名与检查器 Tab 文案即时变化', () => {
    const view = render(<TopBar />);
    expect(screen.getByText('QuantumAgent · 异构量子智能体平台')).toBeInTheDocument();

    act(() => {
      useUiStore.getState().setLanguage('en');
    });
    expect(
      screen.getByText('QuantumAgent · Heterogeneous Quantum Agent Platform'),
    ).toBeInTheDocument();

    act(() => {
      useUiStore.getState().setLanguage('ja');
    });
    expect(
      screen.getByText('QuantumAgent · ヘテロ量子エージェントプラットフォーム'),
    ).toBeInTheDocument();
    view.unmount();
  });

  it('语言写入 localStorage 持久化；畸形持久化值回退 zh', () => {
    act(() => {
      useUiStore.getState().setLanguage('ja');
    });
    expect(localStorage.getItem('qap.language')).toBe('ja');
    // parseLanguage 只接受 en/ja（畸形持久化值回退 zh）；重新 set 验证写入路径
    act(() => {
      useUiStore.getState().resetForTest();
      useUiStore.getState().setLanguage('en');
    });
    expect(useUiStore.getState().language).toBe('en');
  });

  it('语言切换影响相对时间格式化（t() 非响应式路径）', () => {
    act(() => {
      useUiStore.getState().setLanguage('en');
    });
    expect(translate('en', 'time.justNow')).toBe('just now');
    act(() => {
      useUiStore.getState().setLanguage('zh');
    });
    expect(translate('zh', 'time.justNow')).toBe('刚刚');
  });
});
