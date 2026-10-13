/**
 * WaveformCanvas.tsx —— 校准波形渲染器（手写 SVG，ARCHITECTURE §6 waveform）。
 *
 * 职责：I/Q 多通道折线（按全局最大绝对值归一化到绘图高度）；通道图例；
 *      畸形载荷（非对象/通道空/样本非有限）降级提示，不崩溃。
 * Props 契约：{ payload: unknown }。
 * 交互行为：纯只读可视化。
 */
interface WaveChannel {
  label: string;
  samples: number[];
}

function parseWaveform(payload: unknown): { channels: WaveChannel[]; unit: string; sampleRateNs: number } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as { sample_rate_ns?: unknown; unit?: unknown; channels?: unknown };
  if (!Array.isArray(p.channels) || p.channels.length === 0) return null;
  const channels: WaveChannel[] = [];
  for (const ch of p.channels) {
    if (ch === null || typeof ch !== 'object') return null;
    const c = ch as { label?: unknown; samples?: unknown };
    if (!Array.isArray(c.samples) || c.samples.length < 2) return null;
    if (!c.samples.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    channels.push({
      label: typeof c.label === 'string' ? c.label : `CH${channels.length}`,
      samples: c.samples as number[],
    });
  }
  return {
    channels,
    unit: typeof p.unit === 'string' ? p.unit : '',
    sampleRateNs:
      typeof p.sample_rate_ns === 'number' && Number.isFinite(p.sample_rate_ns)
        ? p.sample_rate_ns
        : 0,
  };
}

const PLOT_W = 480;
const PLOT_H = 120;

export function WaveformCanvas(props: { payload: unknown }): JSX.Element {
  const model = parseWaveform(props.payload);
  if (!model) {
    return (
      <p className="viz-note viz-note--error" role="note">
        无法渲染波形：载荷不合法（通道/样本缺失或含非有限值）
      </p>
    );
  }
  const maxAbs = Math.max(
    ...model.channels.flatMap((c) => c.samples.map((v) => Math.abs(v))),
    1e-9,
  );
  const mid = PLOT_H / 2;
  const n = model.channels[0].samples.length;

  return (
    <div className="waveform-wrap">
      <p className="counts-subtitle mono">
        {model.sampleRateNs > 0 ? `采样率 ${model.sampleRateNs} ns` : ''}
        {model.unit ? ` · 单位 ${model.unit}` : ''}
      </p>
      <svg
        data-testid="waveform-svg"
        width={PLOT_W}
        height={PLOT_H}
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        role="img"
        aria-label={`波形（${model.channels.length} 通道，${n} 点）`}
        className="waveform-svg"
      >
        <line x1="0" y1={mid} x2={PLOT_W} y2={mid} className="counts-grid" />
        {model.channels.map((ch, idx) => {
          const points = ch.samples
            .map((v, i) => {
              const x = (i / (n - 1)) * PLOT_W;
              const y = mid - (v / maxAbs) * (mid - 4);
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(' ');
          return (
            <polyline
              key={ch.label}
              data-testid="waveform-channel"
              data-channel-label={ch.label}
              points={points}
              fill="none"
              strokeWidth="1.4"
              className={idx % 2 === 0 ? 'waveform-stroke-a' : 'waveform-stroke-b'}
            />
          );
        })}
      </svg>
      <ul className="waveform-legend">
        {model.channels.map((ch, idx) => (
          <li key={ch.label} className="mono">
            <span
              className={`waveform-legend__dot${idx % 2 === 0 ? ' waveform-legend__dot--a' : ' waveform-legend__dot--b'}`}
              aria-hidden="true"
            />
            {ch.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
