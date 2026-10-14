/**
 * ArtifactCard.tsx —— Artifact 通用卡片（ARCHITECTURE §6 信封 + design.md §5）。
 *
 * 职责：
 *  - 类型徽标（线路/计数/波形；未知类型显示原始 type 字符串）；
 *  - 展开/收起正文（默认收起）；
 *  - 按 type 分发渲染器（renderArtifactBody）；未知/畸形一律降级为
 *    可展开的原始 JSON 视图，**任何输入不崩溃**；
 *  - v1.4 streaming 态：artifact.created 即时插卡渲染骨架/半透明
 *    （`artifact-card--streaming` + aria-busy；message.completed 后由父级
 *    撤销该态转为正常卡）。
 * Props 契约：{ artifact: Artifact, streaming?: boolean }——允许畸形输入
 *  （非对象/缺字段），组件内部防御式归一化。
 * 交互行为：头部整行按钮切换展开；focus-visible ring 全局生效。
 */
import { useState } from 'react';
import { useTranslate } from '../../i18n';
import type { Artifact } from '../../types/domain';
import { renderArtifactBody } from './renderers';

/** 已知类型的徽标 i18n key；未知类型回退为 type 本体（等宽展示）。 */
export const ARTIFACT_TYPE_KEYS: Record<string, string> = {
  circuit: 'artifact.type.circuit',
  counts: 'artifact.type.counts',
  waveform: 'artifact.type.waveform',
};

interface NormalizedArtifact {
  id: string;
  type: string;
  title: string;
  payload: unknown;
  broken: boolean;
}

/** 防御式归一化：任何畸形输入都归约为可渲染的安全形状。 */
function normalizeArtifact(raw: unknown): NormalizedArtifact {
  if (raw === null || typeof raw !== 'object') {
    return { id: '', type: 'unknown', title: '', payload: null, broken: true };
  }
  const obj = raw as Partial<Artifact>;
  const type = typeof obj.type === 'string' && obj.type.length > 0 ? obj.type : 'unknown';
  const title = typeof obj.title === 'string' && obj.title.length > 0 ? obj.title : '';
  const id = typeof obj.id === 'string' ? obj.id : '';
  return { id, type, title, payload: obj.payload, broken: false };
}

/** JSON 安全序列化（循环引用等异常回退 String()）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function ArtifactCard(props: {
  artifact: Artifact;
  /** v1.4：流式插入态（骨架/半透明；completed 后转正常卡） */
  streaming?: boolean;
}): JSX.Element {
  const t = useTranslate();
  const [expanded, setExpanded] = useState(false);
  const a = normalizeArtifact(props.artifact);
  const labelKey = ARTIFACT_TYPE_KEYS[a.type];
  const label = labelKey ? t(labelKey) : a.type;
  const streaming = props.streaming === true;
  const rootCls = streaming ? 'artifact-card card artifact-card--streaming' : 'artifact-card card';
  const busy: { 'aria-busy'?: boolean } = streaming ? { 'aria-busy': true } : {};

  if (a.broken) {
    return (
      <div
        className={rootCls}
        data-artifact-type="broken"
        data-testid="artifact-card"
        {...busy}
      >
        <div className="artifact-card__header">
          <span className="artifact-card__badge mono artifact-card__badge--unknown">
            {t('artifact.broken')}
          </span>
        </div>
        <div className="artifact-card__body">
          <pre className="artifact-json mono">{safeJson(props.artifact)}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className={rootCls} data-artifact-type={a.type} data-testid="artifact-card" {...busy}>
      <button
        type="button"
        className="artifact-card__header"
        aria-expanded={expanded}
        aria-label={t('artifact.toggle')}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`artifact-card__badge mono${labelKey ? '' : ' artifact-card__badge--unknown'}`}>
          {label}
        </span>
        <span className="artifact-card__title truncate">
          {a.title.length > 0 ? a.title : t('artifact.unnamed')}
        </span>
        <span
          className={`artifact-card__chevron${expanded ? ' artifact-card__chevron--open' : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>
      {expanded ? (
        <div className="artifact-card__body fade-in">{renderArtifactBody(a.type, a.payload)}</div>
      ) : null}
    </div>
  );
}
