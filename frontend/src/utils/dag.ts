/**
 * dag.ts —— DAG 布局纯函数（ARCHITECTURE §4 不变量 1：无环/无未知 id）。
 *
 * 职责：
 *  - 依赖边生成：每条 depends_on 产出一条 from→to 边（未知 id 丢弃）；
 *  - 层级分配：最长路径（拓扑 DP）；环存在时 invalid=true 并退化为
 *    出现顺序层级（渲染不崩溃）；
 *  - 同层内排序稳定（按出现顺序）。
 * 失败行为：steps 非数组或元素缺 id → 空模型。
 */
import type { Step } from '../types/domain';

export interface DagNode {
  step: Step;
  layer: number;
  /** 层内序号（布局 y 用） */
  indexInLayer: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagModel {
  nodes: DagNode[];
  edges: DagEdge[];
  invalid: boolean;
  layers: number;
}

export function buildDagModel(steps: unknown): DagModel {
  if (!Array.isArray(steps)) return { nodes: [], edges: [], invalid: false, layers: 0 };

  // 防御式收集：缺 id 的 step 丢弃
  const valid: Step[] = [];
  for (const s of steps) {
    if (s !== null && typeof s === 'object' && typeof (s as Step).id === 'string') {
      valid.push(s as Step);
    }
  }
  const byId = new Map<string, Step>();
  for (const s of valid) byId.set(s.id, s); // 重复 id：后者覆盖（契约禁止，降级处理）

  // 边生成：未知 from 丢弃
  const edges: DagEdge[] = [];
  for (const s of valid) {
    const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
    for (const dep of deps) {
      if (typeof dep === 'string' && byId.has(dep)) {
        edges.push({ from: dep, to: s.id });
      }
    }
  }

  // 最长路径层级（迭代松弛，最多 n 轮；超过则存在环）
  const layerOf = new Map<string, number>();
  for (const s of valid) layerOf.set(s.id, 0);
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }
  let rounds = 0;
  let changed = true;
  while (changed && rounds <= valid.length) {
    changed = false;
    rounds += 1;
    for (const s of valid) {
      const deps = incoming.get(s.id) ?? [];
      let target = 0;
      for (const dep of deps) {
        target = Math.max(target, (layerOf.get(dep) ?? 0) + 1);
      }
      if (target > (layerOf.get(s.id) ?? 0)) {
        layerOf.set(s.id, target);
        changed = true;
      }
    }
  }
  const invalid = changed; // 仍可松弛 → 存在环

  // 组装节点（层内出现顺序）
  const nodes: DagNode[] = valid.map((step) => ({
    step,
    layer: layerOf.get(step.id) ?? 0,
    indexInLayer: 0,
  }));
  const layerCounts = new Map<number, number>();
  for (const node of nodes) {
    const idx = layerCounts.get(node.layer) ?? 0;
    node.indexInLayer = idx;
    layerCounts.set(node.layer, idx + 1);
  }
  const layers = layerCounts.size;

  return { nodes, edges, invalid, layers };
}

/** 时间线行：相对任务起点的时刻（ms）；未开始 → null。 */
export interface TimelineRow {
  step: Step;
  /** 相对任务起点的开始时刻（ms） */
  startMs: number | null;
  /** 实测时长（ms）：finished → duration_ms（缺省回退 finished-started）；
   *  running → now-started（实时增长）；未开始 → null */
  durationMs: number | null;
}

export interface TimelineModel {
  rows: TimelineRow[];
  /** 总时长（ms）= max(起+时长) - min(起)；无已开始步骤 → 0 */
  totalMs: number;
  /** 存在运行中步骤（视图需要定时重渲染使条形实时增长） */
  hasRunning: boolean;
}

/** §6.3 v1.3 时间线模型（水平 Gantt 的纯布局函数；nowMs 可注入测试）。 */
export function buildTimelineModel(steps: unknown, nowMs: number = Date.now()): TimelineModel {
  if (!Array.isArray(steps)) return { rows: [], totalMs: 0, hasRunning: false };

  interface Abs {
    step: Step;
    start: number;
    duration: number;
  }
  const abs: Abs[] = [];
  let hasRunning = false;
  for (const s of steps) {
    if (s === null || typeof s !== 'object' || typeof (s as Step).id !== 'string') continue;
    const step = s as Step;
    const start = typeof step.started_at === 'string' ? Date.parse(step.started_at) : NaN;
    if (!Number.isFinite(start)) continue; // 未开始（或畸形时间）→ 无条形
    const finished =
      typeof step.finished_at === 'string' ? Date.parse(step.finished_at) : NaN;
    let duration: number;
    if (Number.isFinite(finished)) {
      duration =
        typeof step.duration_ms === 'number' && Number.isFinite(step.duration_ms) && step.duration_ms >= 0
          ? step.duration_ms
          : Math.max(0, finished - start);
    } else {
      hasRunning = true;
      duration = Math.max(0, nowMs - start);
    }
    abs.push({ step, start, duration });
  }

  if (abs.length === 0) return { rows: [], totalMs: 0, hasRunning: false };
  const base = Math.min(...abs.map((a) => a.start));
  const end = Math.max(...abs.map((a) => a.start + a.duration));
  return {
    rows: abs.map(({ step, start, duration }) => ({
      step,
      startMs: start - base,
      durationMs: duration,
    })),
    totalMs: Math.max(0, end - base),
    hasRunning,
  };
}
