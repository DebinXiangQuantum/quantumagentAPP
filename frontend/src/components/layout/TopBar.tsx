/**
 * TopBar.tsx —— 56px 顶栏（design.md §5 v1.2 修订）。
 *
 * 职责：
 *  - 左：侧栏折叠按钮 + 产品名（i18n：topbar.product）；
 *  - 中：**常驻外观控件**——主题三档分段图标（dark/light/sepia，即时切换
 *    <html data-theme>）+ 语言三选下拉（self-name 文案，即时生效持久化）；
 *    **模型/思考选择器不在顶栏**（v1.3 迁入 composer 工具条，见 MessageInput）；
 *  - 右：租户徽标（含角色：admin 显示「管理员」徽标、user 不显示）、
 *    SSE 连接状态灯（store.connection）、检查器开关。
 *
 * Props 契约：无 props；全部来自 useAppStore / useUiStore。
 * 降级行为：tenant 未知时显示占位「—」；role 缺失按 user 降级（仅 UX 可见性）。
 */
import { useUiStore, type Language } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { ConnectionLight } from './ConnectionLight';
import { useTranslate } from '../../i18n';
import { parseTenantRole } from '../../types/domain';

/** 主题分段图标（16px 手写 SVG，token 着色）。 */
const THEME_ICONS: Record<string, JSX.Element> = {
  dark: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M9.5 2.2a6 6 0 1 0 4.3 4.3A5 5 0 0 1 9.5 2.2z"
        className="svg-fill-current"
      />
    </svg>
  ),
  light: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" className="svg-fill-current" />
      <g className="svg-stroke-current" strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="1.2" x2="8" y2="2.8" />
        <line x1="8" y1="13.2" x2="8" y2="14.8" />
        <line x1="1.2" y1="8" x2="2.8" y2="8" />
        <line x1="13.2" y1="8" x2="14.8" y2="8" />
        <line x1="3.2" y1="3.2" x2="4.3" y2="4.3" />
        <line x1="11.7" y1="11.7" x2="12.8" y2="12.8" />
        <line x1="3.2" y1="12.8" x2="4.3" y2="11.7" />
        <line x1="11.7" y1="4.3" x2="12.8" y2="3.2" />
      </g>
    </svg>
  ),
  sepia: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.4" fill="none" strokeWidth="1.4" className="svg-stroke-current" />
      <circle cx="8" cy="8" r="1.1" className="svg-fill-current" />
    </svg>
  ),
};

const THEMES = ['dark', 'light', 'sepia'] as const;
/** 语言名用各自语言原文（self-name 惯例，不随当前语言翻译）。 */
const LANGUAGE_NAMES: Record<Language, string> = { zh: '中文', en: 'English', ja: '日本語' };
const LANGUAGES: readonly Language[] = ['zh', 'en', 'ja'];

export function TopBar(): JSX.Element {
  const t = useTranslate();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);

  const tenant = useAppStore((s) => s.tenant);
  const connection = useAppStore((s) => s.connection);
  const role = parseTenantRole(tenant?.role);

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          type="button"
          className="icon-btn"
          data-testid="toggle-sidebar"
          onClick={toggleSidebar}
          aria-label={t('topbar.toggleSidebar')}
          title={t('topbar.toggleSidebar')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1" y="2" width="14" height="1.5" className="svg-fill-current" />
            <rect x="1" y="7.25" width="14" height="1.5" className="svg-fill-current" />
            <rect x="1" y="12.5" width="14" height="1.5" className="svg-fill-current" />
          </svg>
        </button>
        <span className="topbar__product">{t('topbar.product')}</span>
      </div>

      <div className="topbar__center">
        <div
          className="segmented segmented--topbar"
          role="group"
          aria-label={t('topbar.theme')}
        >
          {THEMES.map((id) => (
            <button
              key={id}
              type="button"
              className="segmented__btn"
              data-testid={`topbar-theme-${id}`}
              aria-pressed={theme === id}
              onClick={() => setTheme(id)}
              title={t(`theme.${id}`)}
              aria-label={t(`theme.${id}`)}
            >
              {THEME_ICONS[id]}
            </button>
          ))}
        </div>
        <select
          className="select select--topbar select--language"
          data-testid="topbar-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          aria-label={t('topbar.language')}
        >
          {LANGUAGES.map((id) => (
            <option key={id} value={id}>
              {LANGUAGE_NAMES[id]}
            </option>
          ))}
        </select>
      </div>

      <div className="topbar__right">
        <span
          className="tenant-badge mono"
          data-testid="tenant-badge"
          title={t('topbar.tenant', {
            name: tenant?.name ?? t('topbar.tenantUnknown'),
          })}
        >
          {tenant?.id ?? '—'}
          {role === 'admin' ? (
            <span className="tenant-badge__role" data-testid="tenant-role-badge">
              {t('topbar.role.admin')}
            </span>
          ) : null}
        </span>
        <ConnectionLight status={connection} />
        <button
          type="button"
          className="icon-btn"
          data-testid="toggle-inspector"
          onClick={toggleInspector}
          aria-label={t('topbar.toggleInspector')}
          title={t('topbar.toggleInspector')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="1.75"
              y="2.75"
              width="12.5"
              height="10.5"
              rx="1.5"
              fill="none"
              strokeWidth="1.5"
              className="svg-stroke-current"
            />
            <line
              x1="9.5"
              y1="2.75"
              x2="9.5"
              y2="13.25"
              strokeWidth="1.5"
              className="svg-stroke-current"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
