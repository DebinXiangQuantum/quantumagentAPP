/**
 * WaveformCanvas.test.tsx —— 波形渲染器降级与结构测试。
 *
 * 覆盖：
 *  1. 多通道渲染为多条 polyline，图例含通道标签；
 *  2. 畸形载荷（非对象/样本含 NaN/单点）降级提示，不崩溃。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WaveformCanvas } from './WaveformCanvas';

const PAYLOAD = {
  sample_rate_ns: 1.0,
  unit: 'mV',
  channels: [
    { label: 'Q0 I', samples: [0, 1, 0, -1, 0] },
    { label: 'Q0 Q', samples: [0, 0.5, 0, -0.5, 0] },
  ],
};

describe('WaveformCanvas', () => {
  it('每通道渲染一条 polyline，图例含标签', () => {
    render(<WaveformCanvas payload={PAYLOAD} />);
    expect(screen.getAllByTestId('waveform-channel').length).toBe(2);
    expect(screen.getByText('Q0 I')).toBeInTheDocument();
    expect(screen.getByText('Q0 Q')).toBeInTheDocument();
    expect(screen.getByText(/采样率/)).toBeInTheDocument();
  });

  it('畸形载荷降级提示，不崩溃', () => {
    render(<WaveformCanvas payload={null} />);
    expect(screen.getByText(/无法渲染波形/)).toBeInTheDocument();
    render(
      <WaveformCanvas
        payload={{ channels: [{ label: 'X', samples: [0, Number.NaN] }] }}
      />,
    );
    expect(screen.getAllByText(/无法渲染波形/).length).toBe(2);
  });
});
