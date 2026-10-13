/**
 * SettingsPage.tsx —— 设置页容器（design.md §5 v1.1，四分区）。
 *
 * 职责：
 *  - 覆盖侧栏+对话区（AppShell 条件渲染；检查器保留在右列）；
 *  - 头部：标题 + 关闭按钮（uiStore.closeSettings）；
 *  - 四个分区（§5）：外观（主题/语言）、模型与思考（本地偏好）、
 *    提供商渠道（admin API）、插件管理（admin API）。
 * Props 契约：无 props（数据来自 uiStore/appStore/api）。
 * 失败行为：渠道/插件加载失败 → 分区内联错误条 + 重试；不影响其他分区。
 */
import { useUiStore } from '../../store/uiStore';
import { useTranslate } from '../../i18n';
import { AppearanceSection } from './AppearanceSection';
import { ModelThinkingSection } from './ModelThinkingSection';
import { ChannelsSection } from './ChannelsSection';
import { PluginsSection } from './PluginsSection';

export function SettingsPage(): JSX.Element {
  const t = useTranslate();
  const closeSettings = useUiStore((s) => s.closeSettings);

  return (
    <section className="settings-page" data-testid="settings-page" aria-label={t('settings.title')}>
      <div className="settings-page__inner">
        <header className="settings-page__header">
          <h2 className="settings-page__title">{t('settings.title')}</h2>
          <button
            type="button"
            className="btn btn--sm"
            onClick={closeSettings}
            aria-label={t('settings.close')}
            data-testid="close-settings"
          >
            ✕ {t('settings.close')}
          </button>
        </header>

        <AppearanceSection />
        <ModelThinkingSection />
        <ChannelsSection />
        <PluginsSection />
      </div>
    </section>
  );
}
