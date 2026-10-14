/**
 * CircuitCanvas.test.tsx —— 量子线路渲染器测试（design.md §6.1）。
 *
 * 覆盖：
 *  1. qubit 横线等距对齐（行数 == min(qubits,32)，y 间距 == cellH）；
 *  2. >32 qubits 截断提示；
 *  3. 列压缩：不交叉的相邻门共享列（无空列）；
 *  4. 越界/畸形门被丢弃并提示，不崩溃；
 *  5. 悬停门显示 tooltip（gate/位号）；
 *  6. 畸形载荷（非对象/缺字段）降级为提示文案。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CircuitCanvas } from './CircuitCanvas';

const PAYLOAD = {
  qubits: 2,
  operations: [
    { id: 'op-0', gate: 'H', targets: [0] },
    { id: 'op-1', gate: 'CNOT', controls: [0], targets: [1] },
    { id: 'op-2', gate: 'MEASURE', targets: [0, 1] },
  ],
};

describe('CircuitCanvas', () => {
  it('qubit 横线数量与等距对齐（等宽标签 q0…）', () => {
    render(<CircuitCanvas payload={PAYLOAD} />);
    const lines = screen
      .getAllByTestId('circuit-qubit-line')
      .map((el) => el.getAttribute('data-qubit'));
    expect(lines).toEqual(['0', '1']);
    const ys = screen
      .getAllByTestId('circuit-qubit-line')
      .map((el) => Number(el.getAttribute('y1')));
    expect(ys[1] - ys[0]).toBe(36); // cellH = 36（token）
    expect(screen.getByText('q0')).toBeInTheDocument();
    expect(screen.getByText('q1')).toBeInTheDocument();
  });

  it('>32 qubits 截断为 32 行并显示提示', () => {
    render(
      <CircuitCanvas
        payload={{
          qubits: 40,
          operations: [{ id: 'op-0', gate: 'H', targets: [39] }],
        }}
      />,
    );
    expect(screen.getAllByTestId('circuit-qubit-line').length).toBe(32);
    expect(screen.getByText(/已截断/)).toBeInTheDocument();
  });

  it('列压缩：不同 qubit 的门共享同一列，无空列', () => {
    render(
      <CircuitCanvas
        payload={{
          qubits: 2,
          operations: [
            { id: 'op-0', gate: 'H', targets: [0] },
            { id: 'op-1', gate: 'X', targets: [1] },
            { id: 'op-2', gate: 'Z', targets: [0] },
          ],
        }}
      />,
    );
    const cols = Array.from(
      document.querySelectorAll('[data-testid^="circuit-gate-"]'),
    ).map((el) => el.getAttribute('data-col'));
    // H(q0) 与 X(q1) 共享列 0；Z(q0) 需要新列 1
    expect(new Set(cols).size).toBe(2);
    expect(cols).toEqual(['0', '0', '1']);
  });

  it('越界/畸形门被丢弃并提示，不崩溃', () => {
    render(
      <CircuitCanvas
        payload={{
          qubits: 2,
          operations: [
            { id: 'op-0', gate: 'H', targets: [9] },
            { id: 'op-1', gate: '', targets: [0] },
            'garbage',
          ],
        }}
      />,
    );
    expect(screen.getByText(/已忽略/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('circuit-gate').length).toBe(0);
  });

  it('悬停门显示 tooltip（gate/位号）', () => {
    render(<CircuitCanvas payload={PAYLOAD} />);
    fireEvent.mouseEnter(screen.getByTestId('circuit-gate-op-0'));
    expect(screen.getByTestId('circuit-tooltip')).toHaveTextContent('H');
    expect(screen.getByTestId('circuit-tooltip')).toHaveTextContent('q0');
    fireEvent.mouseLeave(screen.getByTestId('circuit-gate-op-0'));
    expect(screen.queryByTestId('circuit-tooltip')).toBeNull();
  });

  it('畸形载荷降级为提示文案，不崩溃', () => {
    render(<CircuitCanvas payload={null} />);
    expect(screen.getByText(/无法渲染线路/)).toBeInTheDocument();
    render(<CircuitCanvas payload={{ qubits: 0, operations: [] }} />);
    expect(screen.getAllByText(/无法渲染线路/).length).toBe(2);
  });
});

describe('CircuitCanvas v1.5 符号修订', () => {
  const V15_PAYLOAD = {
    qubits: 2,
    operations: [
      { id: 'op-0', gate: 'RX', targets: [0], params: [0.11] },
      { id: 'op-1', gate: 'RZ', targets: [1] },
      { id: 'op-2', gate: 'CZ', controls: [0], targets: [1] },
      { id: 'op-3', gate: 'RZZ', targets: [0, 1], params: [0.23] },
      { id: 'op-4', gate: 'MEASURE', targets: [0, 1] },
    ],
  };

  it('CZ = 竖线 + 两端实心圆点：两个 circle、无 ⊕（无外圈圆/十字线）、无方块', () => {
    render(<CircuitCanvas payload={V15_PAYLOAD} />);
    const cz = screen.getByTestId('circuit-gate-op-2');
    const circles = cz.querySelectorAll('circle');
    expect(circles.length).toBe(2);
    // 两点均为实心控制点样式（复用 circuit-fill-violet）
    for (const c of circles) expect(c.classList.contains('circuit-fill-violet')).toBe(true);
    // 无 ⊕：⊕ 由 r=9 空心圆 + 十字线构成；也无方块
    expect(cz.querySelectorAll('circle[r="9"]').length).toBe(0);
    expect(cz.querySelectorAll('rect').length).toBe(0);
    expect(cz.querySelectorAll('line').length).toBe(1); // 仅竖线（十字线为 2 条）
    expect(cz.querySelectorAll('text').length).toBe(0); // 无标签
  });

  it('RZZ = 竖线 + 两端实心点 + 线中点标签 RZZ(0.23)（等宽）', () => {
    render(<CircuitCanvas payload={V15_PAYLOAD} />);
    const rzz = screen.getByTestId('circuit-gate-op-3');
    expect(rzz.querySelectorAll('circle.circuit-fill-violet').length).toBe(2);
    expect(rzz.querySelectorAll('line').length).toBe(1);
    const label = rzz.querySelector('text');
    expect(label).toHaveTextContent('RZZ(0.23)');
    expect(label?.classList.contains('mono')).toBe(true);
    // 标签位于两导线中点：q0 y=34、q1 y=70（padY16 + cellH36）→ 中点 52
    expect(Number(label?.getAttribute('y'))).toBe(56); // 中点 + 4（基线补偿）
  });

  it('单比特旋转门显示角度 RX(0.11)；params 缺失退化为门名', () => {
    render(<CircuitCanvas payload={V15_PAYLOAD} />);
    expect(screen.getByTestId('circuit-gate-op-0')).toHaveTextContent('RX(0.11)');
    // op-1 RZ 无 params → 仅门名
    const rz = screen.getByTestId('circuit-gate-op-1');
    expect(rz).toHaveTextContent('RZ');
    expect(rz.textContent).not.toContain('RZ(');
  });

  it('tooltip 含角度：悬停 RX 显示 RX(0.11)', () => {
    render(<CircuitCanvas payload={V15_PAYLOAD} />);
    fireEvent.mouseEnter(screen.getByTestId('circuit-gate-op-0'));
    expect(screen.getByTestId('circuit-tooltip')).toHaveTextContent('RX(0.11)');
    fireEvent.mouseLeave(screen.getByTestId('circuit-gate-op-0'));
  });

  it('测量后操作被剔除并提示（渲染层兜底）：CNOT 不出现', () => {
    render(
      <CircuitCanvas
        payload={{
          qubits: 2,
          operations: [
            { id: 'op-0', gate: 'H', targets: [0] },
            { id: 'op-1', gate: 'MEASURE', targets: [0] },
            { id: 'op-2', gate: 'CNOT', controls: [0], targets: [1] },
            { id: 'op-3', gate: 'X', targets: [1] },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId('circuit-gate-op-2')).toBeNull();
    expect(screen.getByTestId('circuit-gate-op-3')).toBeInTheDocument();
    expect(screen.getByText(/测量后/)).toBeInTheDocument();
  });

  it('params 畸形（NaN/负值）不崩溃且退化为门名', () => {
    render(
      <CircuitCanvas
        payload={{
          qubits: 2,
          operations: [
            { id: 'op-0', gate: 'RX', targets: [0], params: [Number.NaN] },
            { id: 'op-1', gate: 'RY', targets: [1], params: [-0.5] },
            { id: 'op-2', gate: 'RZZ', targets: [0, 1], params: ['bad' as never] },
          ],
        }}
      />,
    );
    const rx = screen.getByTestId('circuit-gate-op-0');
    expect(rx.textContent).not.toContain('(');
    const rzz = screen.getByTestId('circuit-gate-op-2');
    expect(rzz).toHaveTextContent('RZZ'); // 两点形状仍在，标签退化为门名
    expect(rzz.textContent).not.toContain('RZZ(');
  });
});
