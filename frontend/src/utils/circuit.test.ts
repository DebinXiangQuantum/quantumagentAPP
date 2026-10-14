/**
 * circuit.test.ts —— 线路布局纯函数测试（design.md §6.1 v1.5 / ARCHITECTURE §6）。
 *
 * 覆盖：
 *  1. v1.5 params：合法有限数值数组保留；畸形（非数组/NaN/非数值）降级 undefined；
 *  2. 测量后防御：某比特 MEASURE 之后仍作用该比特的操作被剔除，计入
 *     dropped 与 droppedAfterMeasure；未测量比特的操作不受影响；
 *  3. gateShape v1.5：RZZ → 'twodot'；CZ（有 controls）→ 'controlled'；
 *     CZ 缺 controls 的宽容形态 → 'twodot'；MEASURE → 'measure'；
 *  4. angleLabelOf：params[0] 两位小数；缺失/畸形 → null（退化门名）；
 *     负角度物理合法必须显示（集成走查修订）。
 */
import { describe, expect, it } from 'vitest';
import { angleLabelOf, gateShape, layoutCircuit } from './circuit';

describe('layoutCircuit v1.5 params 解析', () => {
  it('params 合法有限数组保留原值', () => {
    const r = layoutCircuit({
      qubits: 1,
      operations: [
        { id: 'op-0', gate: 'RY', targets: [0], params: [0.11] },
        { id: 'op-1', gate: 'RZZ', targets: [0], params: [0.23, 1.5] },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.placed[0]?.op.params).toEqual([0.11]);
    expect(r.placed[1]?.op.params).toEqual([0.23, 1.5]);
  });

  it('params 畸形（非数组/NaN/字符串混入）降级，非有限值被滤除', () => {
    const r = layoutCircuit({
      qubits: 1,
      operations: [
        { id: 'op-0', gate: 'RX', targets: [0], params: 'broken' as never },
        { id: 'op-1', gate: 'RY', targets: [0], params: [Number.NaN, 0.5, 'x' as never] },
        { id: 'op-2', gate: 'RZ', targets: [0], params: [] },
      ],
    });
    expect(r.placed[0]?.op.params).toBeUndefined();
    expect(r.placed[1]?.op.params).toEqual([0.5]);
    expect(r.placed[2]?.op.params).toBeUndefined();
  });
});

describe('layoutCircuit 测量后防御（v1.5 不变量）', () => {
  it('MEASURE 之后作用该比特的操作被剔除并计入 droppedAfterMeasure', () => {
    const r = layoutCircuit({
      qubits: 2,
      operations: [
        { id: 'op-0', gate: 'H', targets: [0] },
        { id: 'op-1', gate: 'MEASURE', targets: [0] },
        { id: 'op-2', gate: 'CNOT', controls: [0], targets: [1] }, // q0 已测量 → 剔除
        { id: 'op-3', gate: 'X', targets: [1] }, // q1 未测量 → 保留
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.dropped).toBe(1);
    expect(r.droppedAfterMeasure).toBe(1);
    expect(r.placed.map((p) => p.op.id)).toEqual(['op-0', 'op-1', 'op-3']);
  });

  it('控制位在测量后同样触发剔除；测量指令本身仍保留', () => {
    const r = layoutCircuit({
      qubits: 2,
      operations: [
        { id: 'op-0', gate: 'MEASURE', targets: [1] },
        { id: 'op-1', gate: 'CZ', controls: [0], targets: [1] }, // target q1 已测量
        { id: 'op-2', gate: 'MEASURE', targets: [0] }, // 保留（q0 未测量）
      ],
    });
    expect(r.dropped).toBe(1);
    expect(r.droppedAfterMeasure).toBe(1);
    expect(r.placed.map((p) => p.op.id)).toEqual(['op-0', 'op-2']);
  });
});

describe('gateShape / angleLabelOf（v1.5 符号分类）', () => {
  it('RZZ → twodot；CZ 有 controls → controlled；CZ 缺 controls → twodot 宽容', () => {
    expect(gateShape({ id: 'a', gate: 'RZZ', targets: [0, 1], params: [0.23] })).toBe('twodot');
    expect(gateShape({ id: 'b', gate: 'CZ', controls: [0], targets: [1] })).toBe('controlled');
    expect(gateShape({ id: 'c', gate: 'CZ', targets: [0, 1] })).toBe('twodot');
    expect(gateShape({ id: 'd', gate: 'MEASURE', targets: [0] })).toBe('measure');
    expect(gateShape({ id: 'e', gate: 'H', targets: [0] })).toBe('box');
  });

  it('angleLabelOf：两位小数；缺失/畸形 → null；负角度物理合法必须显示', () => {
    expect(angleLabelOf({ id: 'a', gate: 'RX', targets: [0], params: [0.11] })).toBe('0.11');
    expect(angleLabelOf({ id: 'b', gate: 'RX', targets: [0], params: [0.5] })).toBe('0.50');
    expect(angleLabelOf({ id: 'c', gate: 'RX', targets: [0] })).toBeNull();
    expect(angleLabelOf({ id: 'd', gate: 'RX', targets: [0], params: [Number.NaN] })).toBeNull();
    // 负角度（UCCSD 的 RX(-θ/2) 常见）原样显示——集成走查修订
    expect(angleLabelOf({ id: 'e', gate: 'RX', targets: [0], params: [-0.25] })).toBe('-0.25');
  });
});
