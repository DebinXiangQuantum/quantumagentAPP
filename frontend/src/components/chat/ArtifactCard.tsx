/**
 * ArtifactCard.tsx —— Artifact 通用卡片（ARCHITECTURE §6 信封 + design.md §5）。
 *
 * 职责：
 *  - 类型徽标（线路/计数/波形；未知类型显示原始 type 字符串）；
 *  - 展开/收起正文（默认收起）；
 *  - 按 type 分发渲染器（renderArtifactBody）；未知/畸形一律降级为
 *    可展开的原始 JSON 视图，**任何输入不崩溃**。
 * Props 契约：{ artifact: Artifact }——允许畸形输入（非对象/缺字段），
 *  组件内部防御式归一化。
 * 交互行为：头部整行按钮切换展开；focus-visible ring 全局生效。
 */
import { useState } from 'react';
import type { Artifact } from '../../types/domain';
import { renderArtifactBody } from './renderers';

/** 已知类型的中文徽标；未知类型回退为 type 本体（等宽展示）。 */
export const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  circuit: '线路',
  counts: '计数',
  waveform: '波形',
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

export function ArtifactCard(props: { artifact: Artifact }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const a = normalizeArtifact(props.artifact);
  const label = ARTIFACT_TYPE_LABELS[a.type] ?? a.type;

  if (a.broken) {
    return (
      <div className="artifact-card card" data-artifact-type="broken">
        <div className="artifact-card__header">
          <span className="artifact-card__badge mono artifact-card__badge--unknown">
            无法解析的 Artifact
          </span>
        </div>
        <div className="artifact-card__body">
          <pre className="artifact-json mono">{safeJson(props.artifact)}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-card card" data-artifact-type={a.type}>
      <button
        type="button"
        className="artifact-card__header"
        aria-expanded={expanded}
        aria-label="展开或收起 Artifact"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`artifact-card__badge mono${ARTIFACT_TYPE_LABELS[a.type] ? '' : ' artifact-card__badge--unknown'}`}>
          {label}
        </span>
        <span className="artifact-card__title truncate">
          {a.title.length > 0 ? a.title : '（未命名产物）'}
        </span>
        <span className="artifact-card__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded ? (
        <div className="artifact-card__body fade-in">{renderArtifactBody(a.type, a.payload)}</div>
      ) : null}
    </div>
  );
}
