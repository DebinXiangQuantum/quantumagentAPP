/**
 * fixtures.ts —— Mock 模式内置演示数据（驱动全部面板）。
 *
 * 目的：后端未启动时（VITE_USE_MOCK=1）UI 完整可演示：
 *  3 个 Agent、2 个含历史的会话（含 circuit/counts/waveform/未知类型 artifact）、
 *  成功与运行中各一个任务、5 个硬件节点（含 1 个 offline 演示斜纹降饱和）。
 * 假设：数据形态严格满足 ARCHITECTURE §4 不变量（counts 守恒、容量不超限、
 *  utilization ∈ [0,1]），供硬件面板映射测试直接消费。
 * 失败行为：纯常量，无失败路径；消费方必须 clone 后再修改。
 */
import type {
  AgentInfo,
  Conversation,
  HardwareNode,
  Message,
  Task,
  TenantInfo,
} from '../../types/domain';

export const TENANT: TenantInfo = {
  id: 'demo',
  name: 'Demo 租户',
  usage: { concurrent_tasks: 1, messages_today: 24 },
  quota: { max_concurrent_tasks: 2, max_messages_per_day: 1000 },
};

export const AGENTS: AgentInfo[] = [
  {
    id: 'algorithm-designer',
    name: '量子算法设计',
    description: '问题建模 → 线路合成 → VQE/QAOA 全流程，产出线路与计数可视化。',
    capabilities: ['problem-modeling', 'circuit-synthesis', 'vqe-pipeline'],
    model_ref: 'default',
    builtin: true,
  },
  {
    id: 'calibration',
    name: '量子校准 / 波形',
    description: '单/双比特校准脉冲合成与 RB 表征，产出波形 artifact。',
    capabilities: ['pulse-calibration', 'rb-characterization'],
    model_ref: 'default',
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
        detail: '20 qubit 读出矩阵迭代拟合（预计 3 分钟）。',
        error: null,
      },
    ],
    created_at: '2026-10-13T08:39:58Z',
  },
];

export const HARDWARE_NODES: HardwareNode[] = [
  {
    id: 'qpu-quanta-20q',
    kind: 'qpu',
    name: 'QuANTA 20Q',
    model: 'superconducting-transmon',
    status: 'online',
    utilization: 0.12,
    capacity: 1,
    allocations: [],
  },
  {
    id: 'gpu-a800-0',
    kind: 'gpu',
    name: 'A800 #0',
    model: 'NVIDIA A800 80GB',
    status: 'online',
    utilization: 0.86,
    capacity: 1,
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
    allocations: [],
  },
];
