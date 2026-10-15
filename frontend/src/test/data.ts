/**
 * data.ts —— 测试预置数据（仅供测试：fakeApi 初始状态与组件测试直灌）。
 *
 * v1.6 去 mock 化：原 src/api/mock/fixtures.ts（产品内演示数据）随 mock
 * 引擎删除；其中仍有复用价值的**测试数据**迁入本文件——形态严格满足
 * ARCHITECTURE §4 不变量（counts 守恒、容量不超限、utilization ∈ [0,1]、
 * t2 ≤ 2*t1、网格 id↔(row,col) 一一对应），供 store/组件等价断言消费。
 * 与产品代码零耦合：仅 src/test/** 与 *.test.* 允许 import。
 * 失败行为：纯常量与纯生成器，无失败路径；消费方须 clone 后修改。
 */
import type {
  AgentInfo,
  Conversation,
  Coupler,
  CpuMetrics,
  GpuMetrics,
  HardwareNode,
  Message,
  ModelChannel,
  PluginInfo,
  QpuMetrics,
  QubitInfo,
  QpuTopology,
  Task,
  TenantInfo,
} from '../types/domain';

export const TEST_TENANT: TenantInfo = {
  id: 'demo',
  name: 'Demo 租户',
  enabled: true,
  role: 'admin',
  usage: { active_tasks: 1, messages_today: 24 },
  quota: { max_concurrent_tasks: 2, max_messages_per_day: 1000 },
};

export const TEST_AGENTS: AgentInfo[] = [
  {
    id: 'orchestrator',
    name: '编排调度',
    description: '内置编排 Agent：按任务自主决定调用哪个专家（dispatch_agent）。',
    capabilities: ['dispatch', 'orchestration'],
    model_ref: 'glm-5.3',
    builtin: true,
  },
  {
    id: 'algorithm-designer',
    name: '量子算法设计',
    description: '问题建模 → 线路合成 → VQE/QAOA 全流程，产出线路与计数可视化。',
    capabilities: ['problem-modeling', 'circuit-synthesis', 'vqe-pipeline'],
    model_ref: 'glm-5.3-flash',
    builtin: true,
  },
  {
    id: 'calibration',
    name: '量子校准 / 波形',
    description: '单/双比特校准脉冲合成与 RB 表征，产出波形 artifact。',
    capabilities: ['pulse-calibration', 'rb-characterization'],
    model_ref: 'glm-5.3-flash',
    builtin: true,
  },
  {
    id: 'echo',
    name: '回显测试',
    description: '最小演示插件：流式回显，不产出 artifact。',
    capabilities: ['echo'],
    model_ref: 'default',
    builtin: true,
  },
];

export const TEST_CONVERSATIONS: Conversation[] = [
  {
    id: 'c-1',
    title: 'H2 分子 VQE 基态能量',
    agent_id: 'algorithm-designer',
    tenant_id: 'demo',
    created_at: '2026-10-13T07:40:00Z',
  },
  {
    id: 'c-2',
    title: 'Q0 单比特校准',
    agent_id: 'calibration',
    tenant_id: 'demo',
    created_at: '2026-10-13T08:10:00Z',
  },
  {
    id: 'c-3',
    title: '冒烟：回显',
    agent_id: 'echo',
    tenant_id: 'demo',
    created_at: '2026-10-13T08:30:00Z',
  },
];

/** 历史消息：c-1 展示 Markdown/线路/计数/未知类型降级；c-2 展示波形。 */
export const TEST_MESSAGES_BY_CID: Record<string, Message[]> = {
  'c-1': [
    {
      id: 'm-1',
      conversation_id: 'c-1',
      role: 'user',
      content: '用 2 量子比特估算 H2 的基态能量，给我线路和测量结果。',
      agent_id: 'algorithm-designer',
      artifacts: [],
      created_at: '2026-10-13T07:41:00Z',
    },
    {
      id: 'm-2',
      conversation_id: 'c-1',
      role: 'assistant',
      content:
        '已完成 **H₂ / STO-3G**（0.735 Å 键长）的 VQE 估算。\n\n' +
        '## 能量收敛\n\n' +
        '基态能量收敛至 $$E_0 \\approx -1.1373\\,\\mathrm{Ha}$$，' +
        '期望值 $E(\\theta)=\\langle\\psi(\\theta)|\\hat H|\\psi(\\theta)\\rangle$。\n\n' +
        '| 参数 | 作用位 | 最优值 |\n|---|---|---|\n' +
        '| θ₀ (RY) | q0 | 0.11 |\n| θ₁ (RZ) | q1 | 0.23 |\n',
      reasoning:
        '计划：dispatch_agent("algorithm-designer")，以 STO-3G 建模并合成' +
        '硬件高效 Ansatz，1024 shots 采样。预期产物：circuit + counts。',
      agent_id: 'algorithm-designer',
      artifacts: [
        {
          id: 'a-1',
          type: 'circuit',
          title: 'H2 硬件高效 Ansatz（2 qubits）',
          payload: {
            qubits: 2,
            operations: [
              { id: 'op-0', gate: 'RY', targets: [0], params: [0.11] },
              { id: 'op-1', gate: 'RZ', targets: [1], params: [0.23] },
              { id: 'op-2', gate: 'CNOT', controls: [0], targets: [1] },
              { id: 'op-3', gate: 'CZ', controls: [0], targets: [1] },
              { id: 'op-4', gate: 'RZZ', targets: [0, 1], params: [0.31] },
              { id: 'op-5', gate: 'MEASURE', targets: [0, 1] },
            ],
          },
        },
        {
          id: 'a-2',
          type: 'counts',
          title: '测量计数（1024 shots）',
          payload: {
            shots: 1024,
            qubits: 2,
            counts: { '00': 498, '11': 512, '01': 8, '10': 6 },
          },
        },
        {
          id: 'a-3',
          type: 'energy-landscape',
          title: '能量-键长曲线（未知类型演示）',
          payload: { points: [[0.5, -1.05], [0.735, -1.1372], [1.0, -1.1]] },
        },
      ],
      created_at: '2026-10-13T07:41:30Z',
    },
  ],
  'c-2': [
    {
      id: 'm-3',
      conversation_id: 'c-2',
      role: 'user',
      content: '对 Q0 做一次 X π 脉冲校准。',
      agent_id: 'calibration',
      artifacts: [],
      created_at: '2026-10-13T08:11:00Z',
    },
    {
      id: 'm-4',
      conversation_id: 'c-2',
      role: 'assistant',
      content:
        'Q0 的 **DRAG 校准脉冲**已合成（$\\sigma=20\\,\\mathrm{ns}$，$\\alpha=-0.32$），波形如下。',
      agent_id: 'calibration',
      artifacts: [
        {
          id: 'a-4',
          type: 'waveform',
          title: 'Q0 X π 脉冲（I/Q 双通道）',
          payload: {
            sample_rate_ns: 1.0,
            unit: 'mV',
            channels: [
              {
                label: 'Q0 I',
                samples: Array.from({ length: 128 }, (_, i) =>
                  Number(
                    (
                      320 *
                      Math.exp(-((i - 64) ** 2) / (2 * 20 ** 2)) *
                      Math.cos(0.02 * (i - 64))
                    ).toFixed(3),
                  ),
                ),
              },
              {
                label: 'Q0 Q',
                samples: Array.from({ length: 128 }, (_, i) =>
                  Number(
                    (
                      320 *
                      Math.exp(-((i - 64) ** 2) / (2 * 20 ** 2)) *
                      Math.sin(0.02 * (i - 64))
                    ).toFixed(3),
                  ),
                ),
              },
            ],
          },
        },
      ],
      created_at: '2026-10-13T08:11:20Z',
    },
  ],
  'c-3': [],
};

export const TEST_TASKS: Task[] = [
  {
    id: 't-1',
    conversation_id: 'c-1',
    tenant_id: 'demo',
    name: 'VQE 全流程',
    status: 'succeeded',
    steps: [
      {
        id: 's-0',
        name: '分子积分计算',
        kind: 'classical',
        status: 'succeeded',
        node_id: 'cpu-node-0',
        depends_on: [],
        started_at: '2026-10-13T07:41:05Z',
        finished_at: '2026-10-13T07:41:12Z',
        duration_ms: 7412.7,
        peak_memory_mb: 18.3,
        subtask_id: null,
        detail: 'STO-3G 基组单/双电子积分（缓存命中）。',
        error: null,
      },
      {
        id: 's-1',
        name: 'VQE 线路执行',
        kind: 'quantum',
        status: 'succeeded',
        node_id: 'qpu-quanta-20q',
        depends_on: ['s-0'],
        started_at: '2026-10-13T07:41:12Z',
        finished_at: '2026-10-13T07:41:24Z',
        duration_ms: 11832.5,
        peak_memory_mb: 25.6,
        subtask_id: 't-3',
        detail: '128 组参数采样 × 8 shots，期望值在线聚合。',
        error: null,
      },
      {
        id: 's-2',
        name: '结果后处理',
        kind: 'classical',
        status: 'succeeded',
        node_id: 'cpu-node-0',
        depends_on: ['s-1'],
        started_at: '2026-10-13T07:41:24Z',
        finished_at: '2026-10-13T07:41:26Z',
        duration_ms: null,
        peak_memory_mb: null,
        subtask_id: null,
        detail: '噪声修正 + 能量收敛判据。',
        error: null,
      },
    ],
    created_at: '2026-10-13T07:41:04Z',
  },
  {
    id: 't-2',
    conversation_id: 'c-1',
    tenant_id: 'demo',
    name: '读出矩阵噪声表征（GPU 拟合）',
    status: 'running',
    steps: [
      {
        id: 's-3',
        name: '波形采样批量上传',
        kind: 'classical',
        status: 'succeeded',
        node_id: 'cpu-node-0',
        depends_on: [],
        started_at: '2026-10-13T08:40:00Z',
        finished_at: '2026-10-13T08:40:09Z',
        duration_ms: 9120.4,
        peak_memory_mb: 8.1,
        subtask_id: null,
        detail: '12k 段 IQ 采样整理为张量批次。',
        error: null,
      },
      {
        id: 's-4',
        name: '读出矩阵 MLE 拟合',
        kind: 'classical',
        status: 'running',
        node_id: 'gpu-a800-0',
        depends_on: ['s-3'],
        started_at: '2026-10-13T08:40:09Z',
        finished_at: null,
        duration_ms: null,
        peak_memory_mb: null,
        subtask_id: null,
        detail: '20 qubit 读出矩阵迭代拟合（预计 3 分钟）。',
        error: null,
      },
    ],
    created_at: '2026-10-13T08:39:58Z',
  },
  {
    // 嵌套下钻：t-1 的 s-1（dispatch_agent 步）挂接的子任务
    id: 't-3',
    conversation_id: 'c-1',
    tenant_id: 'demo',
    name: '参数优化子流程',
    status: 'succeeded',
    steps: [
      {
        id: 'ss-0',
        name: '梯度估计',
        kind: 'quantum',
        status: 'succeeded',
        node_id: 'qpu-quanta-20q',
        depends_on: [],
        started_at: '2026-10-13T07:41:13Z',
        finished_at: '2026-10-13T07:41:19Z',
        duration_ms: 5871.2,
        peak_memory_mb: 11.2,
        subtask_id: null,
        detail: '参数移位梯度的 8 组参数化采样。',
        error: null,
      },
      {
        id: 'ss-1',
        name: '经典参数更新',
        kind: 'classical',
        status: 'succeeded',
        node_id: 'cpu-node-0',
        depends_on: ['ss-0'],
        started_at: '2026-10-13T07:41:19Z',
        finished_at: '2026-10-13T07:41:23Z',
        duration_ms: 4210.8,
        peak_memory_mb: 6.4,
        subtask_id: null,
        detail: 'COBYLA 一步更新。',
        error: null,
      },
    ],
    created_at: '2026-10-13T07:41:12Z',
  },
];

// —— QPU 机群生成器（确定性 LCG，避免测试快照漂移）——

/** 线性同余伪随机（确定性；仅测试数据用，非加密）。 */
function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const round1 = (v: number): number => Number(v.toFixed(1));
const round4 = (v: number): number => Number(v.toFixed(4));

/**
 * 网格拓扑 + 逐比特/逐耦合器保真度（模拟区间满足 §4 v1.2 不变量：
 * T1 20–80µs、T2 10–60µs 且 t2 ≤ 2*t1、readout 0.95–0.995、
 * 1Q 0.995–0.9999、2Q 0.98–0.995——simulated，非硬件观测）。
 */
export function makeQpuTopology(rows: number, cols: number, seed: number): QpuTopology {
  const rand = lcg(seed);
  const qubits: QubitInfo[] = [];
  for (let id = 0; id < rows * cols; id += 1) {
    const t1 = 20 + rand() * 60;
    const t2Ceil = Math.min(60, 2 * t1);
    qubits.push({
      id,
      t1_us: round1(t1),
      t2_us: round1(10 + rand() * (t2Ceil - 10)),
      readout_fidelity: round4(0.95 + rand() * 0.045),
      sq_fidelity: round4(0.995 + rand() * 0.0049),
    });
  }
  const couplers: Coupler[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const id = r * cols + c;
      if (c + 1 < cols) {
        couplers.push({ a: id, b: id + 1, tq_fidelity: round4(0.98 + rand() * 0.015) });
      }
      if (r + 1 < rows) {
        couplers.push({ a: id, b: id + cols, tq_fidelity: round4(0.98 + rand() * 0.015) });
      }
    }
  }
  return { layout: 'grid', rows, cols, qubits, couplers };
}

function qpuNode(
  id: string,
  name: string,
  rows: number,
  cols: number,
  seed: number,
  status: 'online' | 'offline',
  utilization: number,
): HardwareNode {
  const metrics: QpuMetrics = {
    qubits_count: rows * cols,
    topology: makeQpuTopology(rows, cols, seed),
  };
  return {
    id,
    kind: 'qpu',
    name,
    model: `superconducting-transmon ${rows * cols}Q`,
    status,
    utilization,
    capacity: 1,
    metrics,
    allocations: [],
  };
}

/** simulated QPU 机群（6 在线 / 4 离线；titan 14×2 演示滚动）。 */
const QPU_NODES: HardwareNode[] = [
  qpuNode('qpu-quanta-20q', 'QuANTA 20Q', 4, 5, 11, 'online', 0.12),
  qpuNode('qpu-helios-16q', 'Helios 16Q', 4, 4, 23, 'online', 0.34),
  qpuNode('qpu-vega-12q', 'Vega 12Q', 3, 4, 37, 'online', 0.08),
  qpuNode('qpu-orion-30q', 'Orion 30Q', 5, 6, 41, 'online', 0.51),
  qpuNode('qpu-lyra-8q', 'Lyra 8Q', 2, 4, 53, 'online', 0.05),
  qpuNode('qpu-draco-20q', 'Draco 20Q', 4, 5, 67, 'online', 0.22),
  qpuNode('qpu-phoenix-16q', 'Phoenix 16Q', 4, 4, 71, 'offline', 0),
  qpuNode('qpu-aquila-12q', 'Aquila 12Q', 3, 4, 83, 'offline', 0),
  qpuNode('qpu-cygnus-6q', 'Cygnus 6Q', 2, 3, 97, 'offline', 0),
  qpuNode('qpu-titan-28q', 'Titan 28Q（长条网格）', 14, 2, 101, 'offline', 0),
];

/**
 * logicalcloud 真机节点（形状镜像 get_backends() 实拉：4 在线/1 离线）。
 * 云端不提供 T1/T2/保真度与利用率——拓扑仅有坐标点，utilization 0=无数据。
 */
function lqQpuNode(
  id: string,
  name: string,
  model: string,
  coordinates: Array<[number, number]>,
  status: 'online' | 'offline',
): HardwareNode {
  const metrics: QpuMetrics = {
    qubits_count: coordinates.length,
    topology: {
      layout: 'cloud',
      rows: 0,
      cols: 0,
      // v1.8：物理坐标直接在 qubits[].x/y（IBM 式芯片摆放）
      qubits: coordinates.map(([x, y], qid) => ({ id: qid, x, y })),
      couplers: [],
    },
  };
  return {
    id,
    kind: 'qpu',
    name,
    model,
    status,
    utilization: 0,
    capacity: 1,
    metrics,
    allocations: [],
  };
}

const gridCoords = (rows: number, cols: number): Array<[number, number]> =>
  Array.from({ length: rows * cols }, (_, i) => [i % cols, Math.floor(i / cols)] as [number, number]);

const LQ_QPU_NODES: HardwareNode[] = [
  lqQpuNode('lq-mq02', 'MQ02', 'MQ02 8Q', gridCoords(2, 4), 'online'),
  lqQpuNode('lq-agate-100', 'AGate-100', 'AGate-100 12Q', gridCoords(3, 4), 'online'),
  lqQpuNode('lq-qz01-surface-code', 'QZ01 surface_code', 'QZ01-surface_code 9Q', gridCoords(3, 3), 'online'),
  lqQpuNode('lq-qz01-repetition-code', 'QZ01 repetition_code', 'QZ01-repetition_code 5Q', gridCoords(1, 5), 'online'),
  lqQpuNode('lq-qz02', 'QZ02', 'QZ02 6Q', gridCoords(2, 3), 'offline'),
];

export const TEST_HARDWARE_NODES: HardwareNode[] = [
  ...QPU_NODES,
  ...LQ_QPU_NODES,
  {
    id: 'gpu-a800-0',
    kind: 'gpu',
    name: 'A800 #0',
    model: 'NVIDIA A800 80GB',
    status: 'online',
    utilization: 0.86,
    capacity: 1,
    metrics: { vram_total_gb: 80.0, vram_used_gb: 12.6 } as GpuMetrics,
    allocations: [
      {
        task_id: 't-2',
        step_id: 's-4',
        agent_id: 'algorithm-designer',
        leased_at: '2026-10-13T08:40:09Z',
      },
    ],
  },
  {
    id: 'gpu-a800-1',
    kind: 'gpu',
    name: 'A800 #1',
    model: 'NVIDIA A800 80GB',
    status: 'online',
    utilization: 0.05,
    capacity: 1,
    metrics: { vram_total_gb: 80.0, vram_used_gb: 61.3 } as GpuMetrics,
    allocations: [],
  },
  {
    id: 'gpu-v100-0',
    kind: 'gpu',
    name: 'V100 #0',
    model: 'NVIDIA V100 32GB',
    status: 'offline',
    utilization: 0,
    capacity: 1,
    metrics: { vram_total_gb: 32.0, vram_used_gb: 0 } as GpuMetrics,
    allocations: [],
  },
  {
    id: 'cpu-node-0',
    kind: 'cpu',
    name: '经典计算节点 #0',
    model: 'EPYC 64C / 256GB',
    status: 'online',
    utilization: 0.37,
    capacity: 4,
    metrics: {
      cpu_cores: 64,
      cpu_usage: 0.37,
      memory_total_gb: 256.0,
      memory_used_gb: 98.4,
    } as CpuMetrics,
    allocations: [],
  },
];

/** 管理渠道池（v1.6：仅真实渠道 openai/anthropic；密钥脱敏）。 */
export const TEST_CHANNELS: ModelChannel[] = [
  {
    ref: 'glm-5.3',
    provider: 'openai',
    model: 'glm-5.3',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_env: 'GLM_API_KEY',
    has_api_key: true,
    default_thinking: 'max',
    timeout_seconds: 120,
  },
  {
    ref: 'glm-5.3-flash',
    provider: 'openai',
    model: 'glm-5.3-flash',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_env: 'GLM_API_KEY',
    has_api_key: false,
    default_thinking: 'high',
    timeout_seconds: 120,
  },
];

/** 基底渠道（config.toml 提交入库）——DELETE 不可删（409）。 */
export const TEST_BASE_CHANNEL_REFS: readonly string[] = ['glm-5.3', 'glm-5.3-flash'];

/** 插件注册表：builtin + installed（含一个 broken 示例）。 */
export const TEST_PLUGINS: PluginInfo[] = [
  {
    id: 'orchestrator',
    name: '编排调度',
    version: '1.0.0',
    description: '内置编排 Agent：自主决定调用哪个专家。',
    enabled: true,
    source: 'builtin',
    capabilities: ['dispatch', 'orchestration'],
    model_ref: 'glm-5.3',
    broken_reason: null,
  },
  {
    id: 'algorithm-designer',
    name: '量子算法设计',
    version: '1.2.0',
    description: '问题建模 → 线路合成 → VQE 全流程。',
    enabled: true,
    source: 'builtin',
    capabilities: ['problem-modeling', 'circuit-synthesis', 'vqe-pipeline'],
    model_ref: 'glm-5.3-flash',
    broken_reason: null,
  },
  {
    id: 'calibration',
    name: '量子校准 / 波形',
    version: '1.1.0',
    description: '校准脉冲合成与 RB 表征。',
    enabled: true,
    source: 'builtin',
    capabilities: ['pulse-calibration', 'rb-characterization'],
    model_ref: 'glm-5.3-flash',
    broken_reason: null,
  },
  {
    id: 'echo',
    name: '回显测试',
    version: '1.0.0',
    description: '最小演示插件：流式回显。',
    enabled: true,
    source: 'builtin',
    capabilities: ['echo'],
    model_ref: 'default',
    broken_reason: null,
  },
  {
    id: 'pulse-seq-compiler',
    name: '脉冲序列编译器',
    version: '0.3.1',
    description: '外部安装示例：把脉冲 DAG 编译为硬件指令序列。',
    enabled: true,
    source: 'installed',
    capabilities: ['pulse-compilation', 'scheduling'],
    model_ref: 'glm-5.3-flash',
    broken_reason: null,
  },
  {
    id: 'legacy-noise-model',
    name: '旧版噪声模型',
    version: '0.9.7',
    description: '外部安装示例：加载失败被注册为 broken，不影响平台其他插件。',
    enabled: false,
    source: 'installed',
    capabilities: [],
    model_ref: 'glm-5.3-flash',
    broken_reason: 'plugin.json 缺少 qap.entry 键（422 语义）',
  },
];
