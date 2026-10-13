/**
 * dag.test.ts —— DAG 布局纯函数测试（ARCHITECTURE §4 不变量 1）。
 *
 * 覆盖：
 *  1. 依赖边生成：edges 数 == sum(depends_on)；
 *  2. 层级分配：链式依赖 0/1/2，菱形依赖取最长路径；
 *  3. 未知依赖 id 丢弃该边；环检测 → invalid 标记且环上节点降层渲染；
 *  4. 畸形 steps（非数组/缺 id）防御式返回空模型。
 */
import { describe, expect, it } from 'vitest';
import { buildDagModel } from './dag';
import type { Step } from '../types/domain';

function step(id: string, dependsOn: string[], kind: Step['kind'] = 'classical'): Step {
  return {
    id,
    name: `步骤 ${id}`,
    kind,
    status: 'pending',
    node_id: null,
    depends_on: dependsOn,
    started_at: null,
    finished_at: null,
    detail: '',
    error: null,
  };
}

describe('buildDagModel', () => {
  it('链式依赖：边数 2、层级 0/1/2', () => {
    const model = buildDagModel([
      step('s-0', []),
      step('s-1', ['s-0'], 'quantum'),
      step('s-2', ['s-1']),
    ]);
    expect(model.edges.length).toBe(2);
    expect(model.nodes.map((n) => n.layer)).toEqual([0, 1, 2]);
    expect(model.edges[0]).toEqual({ from: 's-0', to: 's-1' });
  });

  it('菱形依赖取最长路径层级', () => {
    const model = buildDagModel([
      step('a', []),
      step('b', ['a']),
      step('c', ['a']),
      step('d', ['b', 'c']),
    ]);
    expect(model.edges.length).toBe(4);
    const layer = Object.fromEntries(model.nodes.map((n) => [n.step.id, n.layer]));
    expect(layer.a).toBe(0);
    expect(layer.b).toBe(1);
    expect(layer.c).toBe(1);
    expect(layer.d).toBe(2);
  });

  it('未知依赖 id 的边被丢弃，不崩溃', () => {
    const model = buildDagModel([step('a', []), step('b', ['ghost'])]);
    expect(model.edges.map((e) => e.to)).toEqual([]);
  });

  it('环：invalid 标记，边保留但层级退化为出现顺序', () => {
    const model = buildDagModel([step('a', ['b']), step('b', ['a'])]);
    expect(model.invalid).toBe(true);
    expect(model.nodes.length).toBe(2);
    // 环上节点仍有层级（0 起），渲染不崩溃
    expect(model.nodes.every((n) => n.layer >= 0)).toBe(true);
  });

  it('畸形输入：非数组/缺 id 返回空模型', () => {
    expect(buildDagModel(null as unknown as Step[]).nodes).toEqual([]);
    expect(
      buildDagModel([{ kind: 'agent' } as unknown as Step]).nodes.length,
    ).toBe(0);
  });
});
