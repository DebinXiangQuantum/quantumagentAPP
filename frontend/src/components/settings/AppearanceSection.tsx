/**
 * AppearanceSection.tsx —— 设置页分区一「外观」（design.md §5 v1.1 / §2.1 / §2.2）。
 *
 * 职责：
 *  - 主题三选一卡片（深色/浅色/护眼）：卡片内嵌迷你预览（底色/表面/强调条
 *    直接取自 tokens 的主题常量——token 即单一来源），点击即时切换
 *    （uiStore.setTheme → <html data-theme> 全局生效）；
 *  - 语言三选（中文/English/日本語，语言名用各自语言原文展示）：
 *    uiStore.setLanguage → 全 chrome 即时重渲染。
 * Props 契约：无 props。
 * 失败行为：无 IO，不存在失败路径。
 */
import { useUiStore, type Language } from '../../store/uiStore';
import { useTranslate } from '../../i18n';
import { LIGHT_THEME, SEPIA_THEME, TOKENS, type ThemeId } from '../../styles/tokens';

/** 迷你预览的强调条色序（accent-cyan / accent-violet / success）。 */
function previewPalette(themeId: ThemeId): { bg: string; surface: string; bars: string[] } {
  if (themeId === 'light') {
    return {
      bg: LIGHT_THEME.color.bgBase,
      surface: LIGHT_THEME.color.bgSurface,
      bars: [
        LIGHT_THEME.color.accentCyan,
        LIGHT_THEME.color.accentViolet,
        LIGHT_THEME.color.success,
      ],
    };
  }
  if (themeId === 'sepia') {
    return {
      bg: SEPIA_THEME.color.bgBase,
      surface: SEPIA_THEME.color.bgSurface,
      bars: [
        SEPIA_THEME.color.accentCyan,
        SEPIA_THEME.color.accentViolet,
        SEPIA_THEME.color.success,
      ],
    };
  }
  return {
    bg: TOKENS.color.bgBase,
    surface: TOKENS.color.bgSurface,
    bars: [
      TOKENS.color.accentCyan,
      TOKENS.color.accentViolet,
      TOKENS.color.success,
    ],
  };
}

const THEME_IDS: readonly ThemeId[] = ['dark', 'light', 'sepia'];
/** 语言名用各自语言原文（不随当前语言翻译，self-name 惯例）。 */
const LANGUAGE_NAMES: Record<Language, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
};
const LANGUAGE_IDS: readonly Language[] = ['zh', 'en', 'ja'];

export function AppearanceSection(): JSX.Element {
  const t = useTranslate();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);

  return (
    <section className="settings-section" data-testid="settings-appearance">
      <h3 className="settings-section__title">{t('settings.appearance')}</h3>

      <div className="settings-field">
        <span className="settings-field__label">{t('settings.appearance.theme')}</span>
        <div className="theme-cards" role="group" aria-label={t('settings.appearance.themeAria')}>
          {THEME_IDS.map((id) => {
            const palette = previewPalette(id);
            return (
              <button
                key={id}
                type="button"
                className="theme-card"
                data-testid={`theme-card-${id}`}
                aria-pressed={theme === id}
                onClick={() => setTheme(id)}
              >
                <span
                  className="theme-card__preview"
                  style={{ background: palette.bg }}
                  aria-hidden="true"
                >
                  <span
                    className="theme-card__bar"
                    style={{ background: palette.surface, flex: 1 }}
                  />
                  {palette.bars.map((color) => (
                    <span key={color} className="theme-card__bar" style={{ background: color }} />
                  ))}
                </span>
                <span className="theme-card__label">{t(`theme.${id}`)}</span>
                <span className="theme-card__hint">{t(`theme.${id}.desc`)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-field__label">{t('settings.appearance.language')}</span>
        <div className="segmented" role="group" aria-label={t('settings.appearance.langAria')}>
          {LANGUAGE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="segmented__btn"
              data-testid={`lang-btn-${id}`}
              aria-pressed={language === id}
              onClick={() => setLanguage(id)}
            >
              {LANGUAGE_NAMES[id]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
