/**
 * Drawer.tsx —— 右侧滑入抽屉（design.md §5/§6.3/§6.4，z-drawer 层）。
 *
 * 职责：检查器内的详情抽屉（DAG 节点详情 / 硬件节点详情），带半透明遮罩与
 *      关闭按钮；Esc 关闭。
 * Props 契约：
 *  - open：受控显隐；onClose：关闭回调（遮罩点击/Esc/按钮均触发）；
 *  - title：抽屉标题。
 * 失败行为：title 畸形按空串渲染；children 可为任意节点。
 */
import { useEffect, type ReactNode } from 'react';
import { useTranslate } from '../../i18n';

export function Drawer(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}): JSX.Element {
  const t = useTranslate();
  const { open, onClose } = props;
  const title = typeof props.title === 'string' ? props.title : '';

  // Esc 关闭（仅在打开时挂载监听）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return <></>;

  return (
    <div className="drawer-root" role="presentation">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer card--elevated slide-in-right"
        data-testid="drawer"
        role="dialog"
        aria-modal="false"
        aria-label={title || t('drawer.aria')}
      >
        <div className="drawer__header">
          <span className="drawer__title truncate">{title}</span>
          <button
            type="button"
            className="icon-btn"
            data-testid="drawer-close"
            onClick={onClose}
            aria-label={t('drawer.close')}
            title={t('drawer.closeTitle')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <line x1="2" y1="2" x2="12" y2="12" strokeWidth="1.6" className="svg-stroke-current" />
              <line x1="12" y1="2" x2="2" y2="12" strokeWidth="1.6" className="svg-stroke-current" />
            </svg>
          </button>
        </div>
        <div className="drawer__body">{props.children}</div>
      </aside>
    </div>
  );
}
