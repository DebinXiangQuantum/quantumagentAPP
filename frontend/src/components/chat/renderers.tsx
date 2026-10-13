/**
 * renderers.tsx —— Artifact 正文渲染器分发（ARCHITECTURE §6）。
 *
 * 职责：按 type 分发到专用可视化组件；未知 type / 载荷不匹配 → 原始 JSON 视图。
 * 契约：任何分支都不抛异常（渲染器内部自行降级），保证卡片永不白屏。
 *
 * 当前状态：S3 阶段全部走 JSON 视图；S4/S5 切片将接入 CircuitCanvas /
 * CountsHistogram / WaveformCanvas。
 */
import type { JSX } from 'react';

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
  // 已注册渲染器随切片增长；默认一律降级
  switch (type) {
    default:
      return <JsonFallbackBody payload={payload} />;
  }
}
