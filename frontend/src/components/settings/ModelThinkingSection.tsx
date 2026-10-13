/**
 * ModelThinkingSection.tsx —— 设置页分区二「模型与思考」（design.md §5 v1.1）。
 *
 * 职责：默认模型（渠道池选项）与默认思考程度（off/low/high/max）——
 *  **本地浏览器偏好**（uiStore.defaultModelRef/defaultThinking + localStorage），
 *  bootstrap 时作为顶栏初始选择；发送消息时仍可在顶栏临时覆盖。
 * Props 契约：无 props（渠道列表来自 appStore.modelChannels）。
 * 降级行为：渠道池为空 → 选择器禁用；偏好值不在渠道池 → 显示但提示跟随列表。
 */
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { useTranslate } from '../../i18n';
import { THINKING_LEVELS } from '../../types/domain';

export function ModelThinkingSection(): JSX.Element {
  const t = useTranslate();
  const defaultModelRef = useUiStore((s) => s.defaultModelRef);
  const setDefaultModelRef = useUiStore((s) => s.setDefaultModelRef);
  const defaultThinking = useUiStore((s) => s.defaultThinking);
  const setDefaultThinking = useUiStore((s) => s.setDefaultThinking);
  const channels = useAppStore((s) => s.modelChannels);

  return (
    <section className="settings-section" data-testid="settings-model">
      <h3 className="settings-section__title">{t('settings.model')}</h3>
      <p className="settings-section__desc">{t('settings.model.hint')}</p>

      <div className="settings-row">
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="pref-default-model">
            {t('settings.model.defaultModel')}
          </label>
          <select
            id="pref-default-model"
            className="select"
            data-testid="pref-default-model"
            aria-label={t('settings.model.modelAria')}
            value={defaultModelRef ?? ''}
            disabled={channels.length === 0}
            onChange={(e) => setDefaultModelRef(e.target.value || null)}
          >
            <option value="">{t('settings.model.followDefault')}</option>
            {channels.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.ref} · {c.model}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label className="settings-field__label" htmlFor="pref-default-thinking">
            {t('settings.model.defaultThinking')}
          </label>
          <select
            id="pref-default-thinking"
            className="select"
            data-testid="pref-default-thinking"
            aria-label={t('settings.model.thinkingAria')}
            value={defaultThinking ?? ''}
            onChange={(e) => setDefaultThinking((e.target.value || null) as never)}
          >
            <option value="">{t('settings.model.followDefault')}</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`thinking.${level}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
