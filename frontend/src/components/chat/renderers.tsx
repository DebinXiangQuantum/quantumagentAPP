/**
 * renderers.tsx —— Artifact 正文渲染器分发（ARCHITECTURE §6）。
 *
 * 职责：按 type 分发到专用可视化组件；未知 type / 载荷不匹配 → 原始 JSON 视图。
 * 契约：任何分支都不抛异常（渲染器内部自行降级），保证卡片永不白屏。
 */
import type { JSX } from 'react';
import { CircuitCanvas } from '../viz/CircuitCanvas';
import { CountsHistogram } from '../viz/CountsHistogram';
import { WaveformCanvas } from '../viz/WaveformCanvas';

/** 原始 JSON 降级视图（含"原始数据"标记，供测试与用户识别）。 */
export function JsonFallbackBody(props: { payload: unknown }): JSX.Element {
  let text: string;
  try {
    text = JSON.stringify(props.payload, null, 2) ?? String(props.payload);
  } catch {
    text = String(props.payload);
  }
  return (
    <div className="json-fallback">
      <p className="json-fallback__hint text-faint">原始数据（未注册的渲染器）</p>
      <pre className="artifact-json mono">{text}</pre>
    </div>
  );
}

export function renderArtifactBody(type: string, payload: unknown): JSX.Element {
  switch (type) {
    case 'circuit':
      return <CircuitCanvas payload={payload} />;
    case 'counts':
      return <CountsHistogram payload={payload} />;
    case 'waveform':
      return <WaveformCanvas payload={payload} />;
    default:
      return <JsonFallbackBody payload={payload} />;
  }
}
