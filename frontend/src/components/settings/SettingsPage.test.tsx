/**
 * SettingsPage.test.tsx —— 设置页四分区测试（design.md §5 v1.1）。
 *
 * 覆盖：
 *  1. 外观：主题三选一卡片即时切换（<html data-theme> + localStorage）；
 *     语言三选即时生效（分区标题重渲染）；
 *  2. 模型与思考：默认模型/默认思考写入本地偏好并持久化；
 *  3. 提供商渠道：列表展示（密钥√/default_thinking）；表单校验（必填/
 *     非法值内联错误）；api_key 仅写入不回显（编辑态输入框为空 + password）；
 *     保存调 PUT 并刷新；删除两段式确认；
 *  4. 插件管理：列表（来源徽标/broken 原因）；启停开关调 PUT；
 *     安装（source_path）；卸载两段式确认；
 *  5. 入口/关闭：侧栏齿轮打开设置页（覆盖侧栏+对话区、检查器保留），
 *     关闭按钮返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import { AppShell } from '../layout/AppShell';
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { readFileSync } from 'node:fs';
import { setApi } from '../../api';
import { createFakeApi, type FakeApiClient } from '../../test/fakeApi';

describe('SettingsPage 四分区', () => {
  let client: FakeApiClient;

  beforeEach(() => {
    client = createFakeApi();
    setApi(client);
    useUiStore.getState().resetForTest();
    useAppStore.getState().resetForTest();
    // v1.2：渠道/插件分区仅 admin 可见（本组既有用例默认 admin 视角）
    useAppStore.setState({
      tenant: {
        id: 'demo',
        name: 'Demo 租户',
        enabled: true,
        role: 'admin',
        usage: { active_tasks: 0, messages_today: 0 },
        quota: { max_concurrent_tasks: 2, max_messages_per_day: 1000 },
      },
    });
  });
  afterEach(() => {
    client.dispose();
  });



  it('模型与思考：默认模型/默认思考写入本地偏好', async () => {
    useAppStore.setState({
      modelChannels: [
        { ref: 'glm-5.3', provider: 'openai', model: 'glm-5.3', has_api_key: true, default_thinking: 'max' },
      ],
    });
    render(<SettingsPage />);
    const model = (await screen.findByTestId('pref-default-model')) as HTMLSelectElement;
    act(() => {
      fireEvent.change(model, { target: { value: 'glm-5.3' } });
    });
    expect(useUiStore.getState().defaultModelRef).toBe('glm-5.3');
    expect(localStorage.getItem('qap.defaultModelRef')).toBe('glm-5.3');

    const thinking = screen.getByTestId('pref-default-thinking') as HTMLSelectElement;
    act(() => {
      fireEvent.change(thinking, { target: { value: 'low' } });
    });
    expect(useUiStore.getState().defaultThinking).toBe('low');
    expect(localStorage.getItem('qap.defaultThinking')).toBe('low');
  });

  it('渠道：列表渲染（密钥√ + default_thinking 文案）；表单校验内联错误', async () => {
    render(<SettingsPage />);
    // 列表来自 fakeApi 预置渠道（glm-5.3 / glm-5.3-flash）
    const row = await screen.findByTestId('channel-row-glm-5.3-flash');
    expect(row.textContent).toContain('glm-5.3-flash');
    expect(row.textContent).toContain('未设置密钥');
    expect(row.textContent).toContain('高'); // default_thinking=high

    // 新建表单：ref/model 留空提交 → 内联必填错误，不调 PUT
    act(() => {
      fireEvent.click(screen.getByTestId('channel-new'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('channel-form-save'));
    });
    // ref 与 model 两个必填错误同时内联展示
    expect((await screen.findAllByText(/必填项不能为空/)).length).toBe(2);

    // 超时非法
    const timeout = screen.getByTestId('channel-form-timeout') as HTMLInputElement;
    act(() => {
      fireEvent.change(timeout, { target: { value: '-5' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('channel-form-save'));
    });
    expect(await screen.findByText(/超时必须为正整数/)).toBeInTheDocument();
  });

  it('渠道：编辑态 api_key 输入框为空（永不回显）且 type=password；保存调 PUT + has_api_key', async () => {
    const putSpy = vi.spyOn(client, 'putAdminModel');
    render(<SettingsPage />);
    await screen.findByTestId('channel-row-glm-5.3-flash');
    act(() => {
      fireEvent.click(screen.getAllByText('编辑')[1]); // glm-5.3-flash 行
    });
    const apiKey = (await screen.findByTestId('channel-form-api-key')) as HTMLInputElement;
    expect(apiKey.value).toBe('');
    expect(apiKey.type).toBe('password');
    // ref 为主键：编辑态禁用改名
    expect((screen.getByTestId('channel-form-ref') as HTMLInputElement).disabled).toBe(true);

    act(() => {
      fireEvent.change(apiKey, { target: { value: 'sk-inline-secret' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('channel-form-save'));
    });
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'glm-5.3-flash', api_key_inline: 'sk-inline-secret' }),
      );
    });
    // 保存后：渠道表 has_api_key 变为 √；表单已收起
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-glm-5.3-flash').textContent).toContain(
        '密钥已设置',
      );
    });
    expect(screen.queryByTestId('channel-form')).toBeNull();
  });

  it('渠道：删除两段式确认；基底渠道 409 错误内联展示', async () => {
    render(<SettingsPage />);
    await screen.findByTestId('channel-row-glm-5.3');
    const rowDeleteBtns = screen.getAllByText('删除');
    act(() => {
      fireEvent.click(rowDeleteBtns[0]); // glm-5.3（基底）
    });
    const confirm = screen.getByTestId('channel-delete-confirm-glm-5.3');
    expect(confirm).toBeInTheDocument();
    act(() => {
      fireEvent.click(confirm);
    });
    // fakeApi：基底渠道 → 409，错误内联
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('基底渠道');
    });
  });

  it('插件：列表（来源徽标 + broken 原因）；启停调 PUT；卸载两段确认', async () => {
    const enableSpy = vi.spyOn(client, 'setPluginEnabled');
    const uninstallSpy = vi.spyOn(client, 'uninstallPlugin');
    render(<SettingsPage />);
    const broken = await screen.findByTestId('plugin-item-legacy-noise-model');
    expect(broken.textContent).toContain('已安装');
    expect(broken.textContent).toContain('plugin.json');

    // 启停：关掉 echo
    const toggle = screen.getByTestId('plugin-toggle-echo') as HTMLInputElement;
    act(() => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(enableSpy).toHaveBeenCalledWith('echo', false);
    });

    // 卸载：两段确认 installed 插件
    const item = screen.getByTestId('plugin-item-pulse-seq-compiler');
    act(() => {
      fireEvent.click(item.querySelector('button') as HTMLButtonElement);
    });
    act(() => {
      fireEvent.click(
        screen.getByTestId('plugin-uninstall-confirm-pulse-seq-compiler'),
      );
    });
    await waitFor(() => {
      expect(uninstallSpy).toHaveBeenCalledWith('pulse-seq-compiler');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('plugin-item-pulse-seq-compiler')).toBeNull();
    });
  });

  it('插件：安装（source_path）成功入列；空路径不触发', async () => {
    const installSpy = vi.spyOn(client, 'installPlugin');
    render(<SettingsPage />);
    await screen.findByTestId('plugin-list');
    const input = screen.getByTestId('plugin-source-path') as HTMLInputElement;
    const btn = screen.getByTestId('plugin-install-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // 空路径禁用
    act(() => {
      fireEvent.change(input, { target: { value: './vendor/ftqe-analyzer' } });
    });
    expect(btn.disabled).toBe(false);
    act(() => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(installSpy).toHaveBeenCalledWith({ source_path: './vendor/ftqe-analyzer' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('plugin-item-ftqe-analyzer')).toBeInTheDocument();
    });
  });

  it('入口与关闭：AppShell 中设置页覆盖侧栏+对话区，检查器保留', async () => {
    render(<AppShell />);
    expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
    act(() => {
      useUiStore.getState().openSettings();
    });
    expect(screen.queryByTestId('session-sidebar')).toBeNull();
    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-panel')).toBeInTheDocument(); // 检查器保留
    act(() => {
      fireEvent.click(screen.getByTestId('close-settings'));
    });
    expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });
});

/** v1.2/v1.3：权限分流 + 插件卡状态徽标与信息补全 + 文字边界。 */
describe('设置页权限与插件状态（v1.2/v1.3）', () => {
  let roleClient: FakeApiClient;

  beforeEach(() => {
    roleClient = createFakeApi();
    setApi(roleClient);
    useUiStore.getState().resetForTest();
    useAppStore.getState().resetForTest();
    useAppStore.setState({
      tenant: {
        id: 'demo',
        name: 'Demo 租户',
        enabled: true,
        role: 'admin',
        usage: { active_tasks: 0, messages_today: 0 },
        quota: { max_concurrent_tasks: 2, max_messages_per_day: 1000 },
      },
    });
  });
  afterEach(() => {
    roleClient.dispose();
  });

  it('role=user：渠道/插件分区整体隐藏，仅剩模型分区', async () => {
    useAppStore.setState({
      tenant: useAppStore.getState().tenant && {
        ...useAppStore.getState()!.tenant!,
        role: 'user',
      },
    });
    render(<SettingsPage />);
    // v1.3：外观分区已迁至顶栏常驻控件，设置页不再渲染（模型分区仍在）
    expect(screen.queryByTestId('settings-appearance')).toBeNull();
    await screen.findByTestId('pref-default-model');
    expect(screen.getByTestId('settings-model')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-channels')).toBeNull();
    expect(screen.queryByTestId('settings-plugins')).toBeNull();
    // 不出现管理员徽标
    expect(screen.queryByTestId('settings-admin-badge')).toBeNull();
  });

  it('role=admin：渠道/插件分区可见，分区标题带「管理员」徽标', async () => {
    render(<SettingsPage />);
    await screen.findByTestId('settings-channels');
    expect(screen.getByTestId('settings-plugins')).toBeInTheDocument();
    expect(screen.getAllByTestId('settings-admin-badge').length).toBe(2);
    expect(screen.getAllByText('管理员').length).toBeGreaterThanOrEqual(2);
  });

  it('插件卡状态徽标三态：启用中(success)/已停用(faint)/加载失败(danger+原因)', async () => {
    render(<SettingsPage />);
    // 启用中
    const on = await screen.findByTestId('plugin-status-echo');
    expect(on).toHaveTextContent('启用中');
    expect(on).toHaveClass('plugin-status--success');
    // 加载失败 + broken 原因内联
    const broken = screen.getByTestId('plugin-status-legacy-noise-model');
    expect(broken).toHaveTextContent('加载失败');
    expect(broken).toHaveClass('plugin-status--danger');
    expect(screen.getByTestId('plugin-item-legacy-noise-model').textContent).toContain(
      'plugin.json',
    );
    // 关闭 echo → 刷新后「已停用」
    act(() => {
      fireEvent.click(screen.getByTestId('plugin-toggle-echo'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('plugin-status-echo')).toHaveTextContent('已停用');
      expect(screen.getByTestId('plugin-status-echo')).toHaveClass('plugin-status--faint');
    });
  });

  it('插件卡信息补全：capabilities 标签 + model_ref + 描述可见', async () => {
    render(<SettingsPage />);
    const item = await screen.findByTestId('plugin-item-algorithm-designer');
    expect(item.textContent).toContain('circuit-synthesis'); // capabilities 标签
    expect(item.textContent).toContain('glm-5.3-flash'); // model_ref
    expect(item.textContent).toContain('问题建模'); // 描述
  });

  it('文字边界（v1.2 修复）：容器 min-width:0 / word-break / 表格 overflow-x 规则存在', () => {
    const css = readFileSync('src/styles/settings.css', 'utf8');
    expect(css).toContain('min-width: 0');
    expect(css).toContain('word-break: break-word');
    expect(css).toContain('.channel-table-scroll');
    expect(css).toMatch(/\.channel-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/max-width:\s*100%/);
  });
});
