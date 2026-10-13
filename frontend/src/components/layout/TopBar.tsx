/**
 * TopBar.tsx —— 56px 顶栏（design.md §5，v1.1 修订）。
 *
 * 职责：
 *  - 左：侧栏折叠按钮 + 产品名（i18n：topbar.product）；
 *  - 中：**模型选择器**（admin models 渠道池）+ **思考程度选择器**
 *    （off/low/high/max）——v1.1 移除 Agent 选择器（编排 Agent 自动调度）；
 *    切模型时思考程度默认跟随该渠道 default_thinking，手动改过后本会话保持
 *    （联动逻辑在 appStore.selectModel/selectThinking）；
 *  - 右：租户徽标、SSE 连接状态灯（store.connection）、检查器开关。
 *
 * Props 契约：无 props；全部来自 useAppStore / useUiStore。
 * 降级行为：渠道池未加载时模型选择器禁用（占位"（加载中）"）；
 *   tenant 未知时显示占位「—」。
 */
import { useUiStore } from '../../store/uiStore';
import { useAppStore } from '../../store/appStore';
import { ConnectionLight } from './ConnectionLight';
import { useTranslate } from '../../i18n';
import { THINKING_LEVELS, parseThinkingLevel } from '../../types/domain';

export function TopBar(): JSX.Element {
  const t = useTranslate();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);

  const tenant = useAppStore((s) => s.tenant);
  const connection = useAppStore((s) => s.connection);
  const modelChannels = useAppStore((s) => s.modelChannels);
  const currentModelRef = useAppStore((s) => s.currentModelRef);
  const currentThinkingLevel = useAppStore((s) => s.currentThinkingLevel);
  const selectModel = useAppStore((s) => s.selectModel);
  const selectThinking = useAppStore((s) => s.selectThinking);

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
        <label className="topbar__agent-label text-secondary" htmlFor="topbar-model">
          {t('topbar.model')}
        </label>
        <select
          id="topbar-model"
          className="select select--topbar"
          data-testid="topbar-model"
          value={currentModelRef ?? ''}
          disabled={modelChannels.length === 0}
          onChange={(e) => selectModel(e.target.value)}
          aria-label={t('topbar.currentModel')}
        >
          {modelChannels.length === 0 ? (
            <option value="">{t('topbar.modelLoading')}</option>
          ) : null}
          {modelChannels.map((channel) => (
            <option key={channel.ref} value={channel.ref}>
              {channel.ref} · {channel.model}
            </option>
          ))}
        </select>
        <label
          className="topbar__agent-label text-secondary"
          htmlFor="topbar-thinking"
        >
          {t('topbar.thinking')}
        </label>
        <select
          id="topbar-thinking"
          className="select select--topbar select--thinking"
          data-testid="topbar-thinking"
          value={currentThinkingLevel ?? parseThinkingLevel(null)}
          disabled={modelChannels.length === 0}
          onChange={(e) => selectThinking(parseThinkingLevel(e.target.value))}
          aria-label={t('topbar.currentThinking')}
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`thinking.${level}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="topbar__right">
        <span
          className="tenant-badge mono"
          title={t('topbar.tenant', {
            name: tenant?.name ?? t('topbar.tenantUnknown'),
          })}
        >
          {tenant?.id ?? '—'}
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
