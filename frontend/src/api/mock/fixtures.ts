/**
 * fixtures.ts —— Mock 模式内置演示数据（驱动全部面板）。
 *
 * 目的：后端未启动时（VITE_USE_MOCK=1）UI 完整可演示：
 *  4 个 Agent（v1.1 含 orchestrator 编排入口）、2 个含历史的会话
 *  （含 circuit/counts/waveform/未知类型 artifact + 历史思考过程）、
 *  任务含 v1.3 实测字段与嵌套子任务（t-1/s-1 → t-3 可下钻）、
 *  v1.2 硬件机群：10 台 QPU（6 在线/4 离线，拓扑行列各异；确定性 LCG
 *  生成，含 14×2 长条网格演示滚动）+ 3 GPU + 1 CPU（metrics 齐备）、
 *  管理平台数据：渠道池（glm-5.3/glm-5.3-flash/mock + default_thinking）与
 *  插件注册表（capabilities/model_ref 齐备，含一个 broken 示例）。
 *  租户 role=admin；localStorage['qap.mockRole']='user' 可切普通用户视角。
 * 假设：数据形态严格满足 ARCHITECTURE §4 不变量（counts 守恒、容量不超限、
 *  utilization ∈ [0,1]），供硬件面板映射测试直接消费。
 * 失败行为：纯常量，无失败路径；消费方必须 clone 后再修改。
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
} from '../../types/domain';

export const TENANT: TenantInfo = {
  id: 'demo',
  name: 'Demo 租户',
  enabled: true,
  // §4 v1.2：admin 可见管理分区；mock 演示可经 localStorage['qap.mockRole']
  // = 'user' 切换普通用户视角（引擎 getTenant 读取）
  role: 'admin',
  usage: { active_tasks: 1, messages_today: 24 },
  quota: { max_concurrent_tasks: 2, max_messages_per_day: 1000 },
};

export const AGENTS: AgentInfo[] = [
  {
    id: 'orchestrator',
    name: '编排调度',
    description: 'v1.1 内置编排 Agent：按任务自主决定调用哪个专家（dispatch_agent）。',
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
    model_ref: 'mock',
    builtin: true,
  },
];

export const CONVERSATIONS: Conversation[] = [
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

/** 历史消息：c-1 展示线路+计数+未知类型降级；c-2 展示波形。 */
export const MESSAGES_BY_CID: Record<string, Message[]> = {
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
        '已完成 H2 STO-3G 在 0.735Å 键长下的 VQE 估算：' +
        'Ansatz 采用硬件高效形式，测量基组旋转后能量收敛至 -1.1372 Ha。\n' +
        '线路与 1024 shots 计数如下；末尾附带一份未注册类型的产物用于演示降级渲染。',
      reasoning:
        '用户要估算 H2 基态能量并查看线路与测量结果——属于量子算法设计任务。\n' +
        '计划：dispatch_agent("algorithm-designer")，专家将以 STO-3G 基组建模、' +
        '合成硬件高效 Ansatz（RY/RZ + CNOT），并在 QPU 上执行 1024 shots 采样。\n' +
        '预期产物：circuit + counts 两个 artifact；能量收敛判据 1e-4 Ha。',
      agent_id: 'algorithm-designer',
      artifacts: [
        {
          id: 'a-1',
          type: 'circuit',
          title: 'H2 硬件高效 Ansatz（2 qubits）',
          payload: {
            qubits: 2,
            operations: [
              { id: 'op-0', gate: 'RY', targets: [0] },
              { id: 'op-1', gate: 'RZ', targets: [1] },
              { id: 'op-2', gate: 'CNOT', controls: [0], targets: [1] },
              { id: 'op-3', gate: 'RZ', targets: [1] },
              { id: 'op-4', gate: 'CNOT', controls: [0], targets: [1] },
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
      content: 'Q0 的 DRAG 校准脉冲已合成（σ=20ns，α=-0.32），波形如下。',
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

export const TASKS: Task[] = [
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
    // v1.3 嵌套下钻演示：t-1 的 s-1（dispatch_agent 步）挂接的子任务
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

// —— v1.2 QPU 机群生成器（确定性 LCG，避免测试快照漂移）——

/** 线性同余伪随机（确定性；仅演示数据用，非加密）。 */
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
 * 网格拓扑 + 逐比特/逐耦合器保真度（模拟区间：T1 20–80µs、T2 10–60µs 且
 * t2 ≤ 2*t1、readout 0.95–0.995、1Q 0.995–0.9999、2Q 0.98–0.995——
 * ARCHITECTURE §4 v1.2 不变量与模拟区间逐条满足；simulated，非硬件观测）。
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
  const topology = makeQpuTopology(rows, cols, seed);
  const metrics: QpuMetrics = { qubits_count: rows * cols, topology };
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

/** v1.2 机群：10 台 QPU（6 在线 / 4 离线，拓扑各异；titan 14×2 演示滚动）。 */
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

const CPU_METRICS: CpuMetrics = {
  cpu_cores: 64,
  cpu_usage: 0.37,
  memory_total_gb: 256.0,
  memory_used_gb: 98.4,
};

const GPU_A800_METRICS: GpuMetrics = { vram_total_gb: 80.0, vram_used_gb: 12.6 };
const GPU_A800_1_METRICS: GpuMetrics = { vram_total_gb: 80.0, vram_used_gb: 61.3 };
const GPU_V100_METRICS: GpuMetrics = { vram_total_gb: 32.0, vram_used_gb: 0 };

export const HARDWARE_NODES: HardwareNode[] = [
  ...QPU_NODES,
  {
    id: 'gpu-a800-0',
    kind: 'gpu',
    name: 'A800 #0',
    model: 'NVIDIA A800 80GB',
    status: 'online',
    utilization: 0.86,
    capacity: 1,
    metrics: GPU_A800_METRICS,
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
    metrics: GPU_A800_1_METRICS,
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
    metrics: GPU_V100_METRICS,
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
    metrics: CPU_METRICS,
    allocations: [],
  },
];

/** §5 v1.1 管理平台渠道池（GLM 实测渠道 + mock；密钥脱敏，只报 has_api_key）。 */
export const ADMIN_MODELS: ModelChannel[] = [
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
  {
    ref: 'mock',
    provider: 'mock',
    model: 'mock-llm',
    base_url: '',
    api_key_env: '',
    has_api_key: true,
    default_thinking: 'high',
    timeout_seconds: 30,
  },
];

/** 基底渠道（config.toml 提交入库）——DELETE 不可删（409），仅本地覆盖渠道可删。 */
export const BASE_CHANNEL_REFS: readonly string[] = ['glm-5.3', 'glm-5.3-flash', 'mock'];

/** §8 v1.1 插件注册表：builtin + installed（含一个 broken 演示条目）。 */
export const ADMIN_PLUGINS: PluginInfo[] = [
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
    model_ref: 'mock',
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
