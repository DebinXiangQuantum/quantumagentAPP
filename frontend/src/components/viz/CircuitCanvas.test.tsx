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
