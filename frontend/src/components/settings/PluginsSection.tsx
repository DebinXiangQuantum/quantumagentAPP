/**
 * PluginsSection.tsx —— 设置页分区四「插件管理」（design.md §5 v1.1，admin API）。
 *
 * 职责：
 *  - 已装插件列表（v1.3 状态徽标补全）：名称/版本/启用开关（switch，PUT
 *    enabled）/来源（builtin·installed 徽标）/**状态徽标**（启用中=success /
 *    已停用=faint / 加载失败=danger+broken 原因内联）/capabilities 标签/
 *    绑定 model_ref/描述；
 *  - 安装：本地 source_path 输入 + 安装按钮（POST install；错误内联展示）；
 *  - 卸载：两段式内联确认；builtin 由后端 409 拒绝（错误内联展示）。
 * Props 契约：无 props（直接经 getApi() 调用 admin 端点）。
 */
import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../../api';
import { useTranslate } from '../../i18n';
import type { PluginInfo } from '../../types/domain';

export function PluginsSection(props: { adminBadge?: boolean }): JSX.Element {
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
      <h3 className="settings-section__title settings-section__title--row">
        {t('settings.plugins')}
        {props.adminBadge ? (
          <span className="settings-admin-badge" data-testid="settings-admin-badge">
            {t('topbar.role.admin')}
          </span>
        ) : null}
      </h3>
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
                <span className="plugin-item__title-row">
                  <span className="plugin-item__name">{plugin.name}</span>
                  {(() => {
                    const state =
                      plugin.broken_reason !== null ? 'broken' : plugin.enabled ? 'on' : 'off';
                    const cls =
                      state === 'broken' ? 'danger' : state === 'on' ? 'success' : 'faint';
                    const label =
                      state === 'broken'
                        ? t('settings.plugins.status.broken')
                        : state === 'on'
                          ? t('settings.plugins.status.on')
                          : t('settings.plugins.status.off');
                    return (
                      <span
                        className={`plugin-status plugin-status--${cls}`}
                        data-testid={`plugin-status-${plugin.id}`}
                      >
                        <span className="plugin-status__dot" aria-hidden="true" />
                        {label}
                      </span>
                    );
                  })()}
                </span>
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
                  {typeof plugin.model_ref === 'string' && plugin.model_ref.length > 0 ? (
                    <span className="mono plugin-item__model">
                      {t('settings.plugins.modelRef', { ref: plugin.model_ref })}
                    </span>
                  ) : null}
                </span>
                {plugin.description.length > 0 ? (
                  <span className="plugin-item__desc">{plugin.description}</span>
                ) : null}
                {Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0 ? (
                  <span className="plugin-item__caps">
                    {plugin.capabilities.map((cap) => (
                      <span key={cap} className="plugin-cap mono">
                        {cap}
                      </span>
                    ))}
                  </span>
                ) : null}
                {plugin.broken_reason ? (
                  <span className="plugin-item__broken">
                    {t('settings.plugins.broken', { reason: plugin.broken_reason })}
                  </span>
                ) : null}
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
