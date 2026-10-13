/**
 * ArtifactCard.test.tsx —— Artifact 卡片降级与交互测试（ARCHITECTURE §6）。
 *
 * 覆盖：
 *  1. 已知类型渲染类型徽标（线路/计数/波形）；
 *  2. 未知 type 降级为原始 JSON 视图，**不得崩溃**；
 *  3. 畸形 artifact（非对象/缺 id/缺 title/payload 非 JSON 安全）→ 降级渲染；
 *  4. 展开/收起交互。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactCard } from './ArtifactCard';
import type { Artifact } from '../../types/domain';

describe('ArtifactCard', () => {
  it('未知 type 降级为原始 JSON 视图且不崩溃', () => {
    const artifact: Artifact = {
      id: 'a-x',
      type: 'energy-landscape',
      title: '能量曲线',
      payload: { points: [[0.5, -1.05]] },
    };
    render(<ArtifactCard artifact={artifact} />);
    expect(screen.getByText('能量曲线')).toBeInTheDocument();
    // 卡片可展开；展开后为原始 JSON 视图
    fireEvent.click(screen.getByRole('button', { name: /展开或收起/ }));
    expect(screen.getByText(/原始数据/)).toBeInTheDocument();
    expect(screen.getByText(/energy-landscape/)).toBeInTheDocument();
  });

  it('畸形 artifact（非对象/缺字段）降级渲染不崩溃', () => {
    // 非法 envelope：直接把垃圾传进去（broken 分支：正文常驻展开）
    render(<ArtifactCard artifact={null as unknown as Artifact} />);
    expect(screen.getByText(/无法解析的 Artifact/)).toBeInTheDocument();
    expect(screen.getByText(/null/)).toBeInTheDocument();
  });

  it('缺 type/title 的 envelope 归一化后仍可展开查看 JSON', () => {
    render(
      <ArtifactCard artifact={{ id: 'a-y' } as unknown as Artifact} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /展开或收起/ }));
    expect(screen.getByText(/原始数据/)).toBeInTheDocument();
  });

  it('已知类型显示中文类型徽标', () => {
    const cases: Array<[string, RegExp]> = [
      ['circuit', /线路/],
      ['counts', /计数/],
      ['waveform', /波形/],
    ];
    for (const [type, label] of cases) {
      const { unmount } = render(
        <ArtifactCard
          artifact={{
            id: 'a-1',
            type,
            title: 'T',
            payload: { qubits: 1, operations: [] },
          }}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('展开/收起：默认收起正文，点击头部切换', () => {
    const artifact: Artifact = {
      id: 'a-q',
      type: 'mystery',
      title: '神秘产物',
      payload: { k: 42 },
    };
    render(<ArtifactCard artifact={artifact} />);
    expect(screen.queryByText(/"k"/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /展开或收起/ }));
    expect(screen.getByText(/"k"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展开或收起/ }));
    expect(screen.queryByText(/"k"/)).toBeNull();
  });
});
