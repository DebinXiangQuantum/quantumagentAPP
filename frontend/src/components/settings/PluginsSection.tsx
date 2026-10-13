/**
 * PluginsSection.tsx —— 设置页分区四「插件管理」（design.md §5 v1.1，admin API）。
 *
 * 职责：
 *  - 已装插件列表：名称/版本/启用开关（switch，PUT enabled）/来源
 *    （builtin·installed 徽标）/broken 原因（danger 内联）；
 *  - 安装：本地 source_path 输入 + 安装按钮（POST install；错误内联展示）；
 *  - 卸载：两段式内联确认；builtin 由后端 409 拒绝（错误内联展示）。
 * Props 契约：无 props（直接经 getApi() 调用 admin 端点）。
 */
import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../../api';
import { useTranslate } from '../../i18n';
import type { PluginInfo } from '../../types/domain';

export function PluginsSection(): JSX.Element {
  const t = useTranslate();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState('');
  const [installing, setInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [armedUninstallId, setArmedUninstallId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await getApi().listAdminPlugins();
      setPlugins(Array.isArray(list?.plugins) ? list.plugins : []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const install = async (): Promise<void> => {
    const path = sourcePath.trim();
    if (path.length === 0) return;
    setInstalling(true);
    setActionError(null);
    try {
      await getApi().installPlugin({ source_path: path });
      setSourcePath('');
      await reload();
    } catch (err) {
      setActionError(
        t('settings.plugins.installError', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setInstalling(false);
    }
  };

  const toggle = async (plugin: PluginInfo): Promise<void> => {
    setActionError(null);
    try {
      await getApi().setPluginEnabled(plugin.id, !plugin.enabled);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const uninstall = async (id: string): Promise<void> => {
    setActionError(null);
    try {
      await getApi().uninstallPlugin(id);
      setArmedUninstallId(null);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setArmedUninstallId(null);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-plugins">
      <h3 className="settings-section__title">{t('settings.plugins')}</h3>
      <p className="settings-section__desc">{t('settings.plugins.desc')}</p>

      {loadError ? (
        <div className="settings-inline-error" role="alert">
          {loadError}
          <button type="button" className="btn btn--sm" onClick={() => void reload()}>
            {t('settings.channels.refresh')}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="settings-inline-error" role="alert">{actionError}</div>
      ) : null}

      <div className="settings-field">
        <label className="settings-field__label" htmlFor="plugin-source-path">
          {t('settings.plugins.installPath')}
        </label>
        <div className="channel-form__actions" style={{ justifyContent: 'flex-start' }}>
          <input
            id="plugin-source-path"
            className="input mono"
            data-testid="plugin-source-path"
            style={{ flex: 1 }}
            placeholder="./vendor/my-plugin"
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary"
            data-testid="plugin-install-btn"
            disabled={installing || sourcePath.trim().length === 0}
            onClick={() => void install()}
          >
            {installing ? t('form.saving') : t('settings.plugins.install')}
          </button>
        </div>
      </div>

      {loading && plugins.length === 0 ? (
        <div className="skeleton" style={{ height: '64px' }} aria-busy="true" />
      ) : plugins.length === 0 ? (
        <p className="settings-hint">{t('settings.plugins.empty')}</p>
      ) : (
        <ul className="plugin-list" data-testid="plugin-list">
          {plugins.map((plugin) => (
            <li key={plugin.id} className="plugin-item" data-testid={`plugin-item-${plugin.id}`}>
              <label
                className="switch"
                title={t('settings.plugins.toggle', { name: plugin.name })}
              >
                <input
                  type="checkbox"
                  role="switch"
                  data-testid={`plugin-toggle-${plugin.id}`}
                  checked={plugin.enabled}
                  disabled={plugin.broken_reason !== null}
                  onChange={() => void toggle(plugin)}
                  aria-label={t('settings.plugins.toggle', { name: plugin.name })}
                />
                <span className="switch__track" aria-hidden="true" />
                <span className="switch__thumb" aria-hidden="true" />
              </label>
              <div className="plugin-item__main">
                <span className="plugin-item__name">{plugin.name}</span>
                <span className="plugin-item__meta">
                  <span className="mono">{plugin.id}</span>
                  {plugin.version.length > 0 ? (
                    <span className="mono">v{plugin.version}</span>
                  ) : null}
                  <span
                    className={`plugin-badge${plugin.source === 'installed' ? ' plugin-badge--installed' : ''}`}
                  >
                    {t(
                      plugin.source === 'builtin'
                        ? 'settings.plugins.source.builtin'
                        : 'settings.plugins.source.installed',
                    )}
                  </span>
                  {plugin.broken_reason ? (
                    <span className="plugin-item__broken">
                      {t('settings.plugins.broken', { reason: plugin.broken_reason })}
                    </span>
                  ) : null}
                </span>
              </div>
              {plugin.source === 'installed' ? (
                armedUninstallId === plugin.id ? (
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    data-testid={`plugin-uninstall-confirm-${plugin.id}`}
                    title={t('settings.plugins.uninstallConfirm', { name: plugin.name })}
                    onClick={() => void uninstall(plugin.id)}
                  >
                    {t('settings.plugins.uninstall')}?
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setArmedUninstallId(plugin.id)}
                  >
                    {t('settings.plugins.uninstall')}
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
