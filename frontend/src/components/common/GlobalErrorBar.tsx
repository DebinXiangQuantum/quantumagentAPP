/**
 * GlobalErrorBar.tsx —— 全局错误警示条（design.md §7 错误态）。
 *
 * 职责：bootstrap 失败时在顶栏下方展示内联警示条 + 重试按钮。
 * Props 契约：{ message: string; retry: () => void }——畸形值按空串/no-op 降级。
 * 交互行为：重试按钮触发回调（store.retryBootstrap）。
 */
import { useTranslate } from '../../i18n';

export function GlobalErrorBar(props: { message: string; retry: () => void }): JSX.Element {
  const t = useTranslate();
  const message = typeof props.message === 'string' ? props.message : '';
  const retry = typeof props.retry === 'function' ? props.retry : () => undefined;
  return (
    <div className="global-error" role="alert">
      <div className="error-bar global-error__bar">
        <span className="truncate">{message}</span>
        <button type="button" className="btn btn--sm" onClick={retry}>
          {t('error.retry')}
        </button>
      </div>
    </div>
  );
}
