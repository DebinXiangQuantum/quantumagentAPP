/**
 * domain.ts —— 领域模型 TypeScript 契约（逐字段对齐 docs/ARCHITECTURE.md §4–§7）。
 *
 * 约束：
 *  - 这些类型是后端 JSON 的镜像，字段名/可空性不得私自偏移；
 *  - 所有联合类型（role/status/kind）为封闭枚举；
 *  - Artifact.payload 保持 unknown：渲染侧必须防御式校验后使用。
 */

/** §4 AgentInfo */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  model_ref: string;
  builtin: boolean;
}

/** §4 Conversation */
export interface Conversation {
  id: string;
  title: string;
  agent_id: string;
  tenant_id: string;
  created_at: string;
}

/** §4 Message.role */
export type MessageRole = 'user' | 'assistant';

/** §4 Message（artifacts 仅 assistant 消息通常携带，但契约上两角色均可能有）。
 * v1.1：reasoning 承载思考过程全文（可为空串）；TS 侧可选以容错旧数据/畸形包。 */
export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  /** v1.1：思考过程全文（后端契约必有该键；缺省按 '' 降级） */
  reasoning?: string;
  agent_id: string;
  artifacts: Artifact[];
  /** §5.2 v1.3：附件条（可选，缺省 []；用户消息内嵌附件条渲染复用） */
  attachments?: AttachmentMeta[];
  created_at: string;
}

/** §4 ThinkingLevel（v1.1）——思考程度归一化枚举。 */
export type ThinkingLevel = 'off' | 'low' | 'high' | 'max';

/** §5.2 v1.3 AttachmentMeta —— 附件元数据（上传响应与 Message.attachments 共用）。 */
export type AttachmentKind = 'image' | 'text' | 'file';
export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

/** 合法思考程度清单（UI 选择器与校验共用；顺序即展示顺序）。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'low',
  'high',
  'max',
];

/** 防御式解析：未知值降级为 'high'（契约缺省值）。 */
export function parseThinkingLevel(raw: unknown): ThinkingLevel {
  return raw === 'off' || raw === 'low' || raw === 'max' ? raw : 'high';
}

/** §5 v1.1 ModelChannel —— 管理平台渠道池条目（GET /admin/models 返回形状，密钥脱敏）。 */
export interface ModelChannel {
  ref: string;
  provider: 'openai' | 'anthropic' | 'mock';
  model: string;
  base_url: string;
  /** 密钥来源二选一：环境变量名 / 本地内联（GET 只报 has_api_key，不回明文） */
  api_key_env: string;
  /** env 已解析到非空值，或本地文件内联了密钥 */
  has_api_key: boolean;
  default_thinking: ThinkingLevel;
  timeout_seconds: number;
}

/** §5 v1.1 ModelChannelInput —— PUT /admin/models/{ref} 请求体。 */
export interface ModelChannelInput {
  ref: string;
  provider: 'openai' | 'anthropic' | 'mock';
  model: string;
  base_url: string;
  api_key_env: string;
  default_thinking: ThinkingLevel;
  timeout_seconds: number;
  /** 只写入不回显的明文密钥（落 config.local.toml，gitignored） */
  api_key_inline?: string;
}

/** §5 v1.1 ModelChannelList —— GET /admin/models 响应信封。 */
export interface ModelChannelList {
  models: ModelChannel[];
}

/** §8 v1.1 PluginInfo —— 已注册插件（builtin 与 installed，含 broken 原因）。 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  source: 'builtin' | 'installed';
  /** 非空 = 插件加载失败被注册为 broken（不拖垮平台） */
  broken_reason: string | null;
  /** §8 v1.3：插件能力标签（设置页插件卡展示；缺省降级隐藏） */
  capabilities?: string[];
  /** §8 v1.3：绑定的模型渠道 ref（缺省降级隐藏） */
  model_ref?: string;
}

/** GET /admin/plugins 响应信封。 */
export interface PluginList {
  plugins: PluginInfo[];
}

/** POST /admin/plugins/install 请求体。 */
export interface InstallPluginRequest {
  source_path: string;
}

/** §6 Artifact 统一信封；type 开放（未知类型必须降级为 JSON 卡片） */
export interface Artifact {
  id: string;
  type: string;
  title: string;
  payload: unknown;
}

/** §6 circuit 载荷（v1.5：operation 增 params 角度数组） */
export interface CircuitOperation {
  id: string;
  gate: string;
  targets: number[];
  controls?: number[];
  /** v1.5：旋转门角度（RX/RY/RZ/RZZ 为 [θ] 有限值；缺省/畸形由渲染层退化为门名） */
  params?: number[];
}
export interface CircuitPayload {
  qubits: number;
  operations: CircuitOperation[];
}

/** §6 counts 载荷（不变量：sum(counts)==shots；键长==qubits） */
export interface CountsPayload {
  shots: number;
  qubits: number;
  counts: Record<string, number>;
}

/** §6 waveform 载荷 */
export interface WaveformChannel {
  label: string;
  samples: number[];
}
export interface WaveformPayload {
  sample_rate_ns: number;
  unit: string;
  channels: WaveformChannel[];
}

/** §4 Task/Step 状态机 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** §4 Step.kind：quantum=violet / classical=info / agent=warning（design.md §2） */
export type StepKind = 'quantum' | 'classical' | 'agent';

export interface Step {
  id: string;
  name: string;
  kind: StepKind;
  status: TaskStatus;
  /** 分配到的硬件节点；未调度为 null */
  node_id: string | null;
  depends_on: string[];
  started_at: string | null;
  finished_at: string | null;
  /** §4 v1.3：实测墙钟时长（perf_counter 差，ms）；未完成/不可得为 null */
  duration_ms?: number | null;
  /** §4 v1.3：实测峰值内存（tracemalloc，MB）；不可得为 null（UI 显示 "—"） */
  peak_memory_mb?: number | null;
  /** §4 v1.3：该步展开的子任务 id（嵌套 DAG 下钻入口）；无则 null */
  subtask_id?: string | null;
  /** §4 v1.4：quantum 步可携带线路（§6 CircuitPayload 同构）；无则 null */
  circuit?: CircuitPayload | null;
  /** §4 v1.4：云端任务 id（logicalcloud 模式）；无则 null */
  cloud_job_id?: string | null;
  /** §4 v1.4：排队位置（int|null；排队期间经 task.updated 持续更新） */
  queue_position?: number | null;
  detail: string;
  error: string | null;
}

export interface Task {
  id: string;
  conversation_id: string;
  tenant_id: string;
  name: string;
  status: TaskStatus;
  steps: Step[];
  created_at: string;
}

/** §4 HardwareNode / Allocation */
export type NodeKind = 'gpu' | 'qpu' | 'cpu';
export type NodeStatus = 'online' | 'offline';

export interface Allocation {
  task_id: string;
  step_id: string;
  agent_id: string;
  leased_at: string;
}

/** §4 v1.2 QPU metrics：拓扑结构 + 逐比特/逐耦合器保真度。
 * v1.4：logicalcloud 真机**不提供** T1/T2/保真度——字段改为可选，
 * 前端按"平台未提供"降级（坐标点渲染，见 QpuTopologyCanvas）。 */
export interface QubitInfo {
  /** id = row*cols + col（grid 布局一一对应） */
  id: number;
  /** 物理坐标（芯片布局列/行，v1.8：云端 qubit_coordinates 镜像；缺省走 grid 摆放） */
  x?: number;
  y?: number;
  /** 相干时间 T1（µs，> 0）；云端真机缺省 */
  t1_us?: number;
  /** 相干时间 T2（µs，> 0 且 ≤ 2*t1_us）；云端真机缺省 */
  t2_us?: number;
  /** 读出保真度 ∈ (0,1]；云端真机缺省 */
  readout_fidelity?: number;
  /** 单比特门保真度 ∈ (0,1]；云端真机缺省 */
  sq_fidelity?: number;
}

export interface Coupler {
  /** 网格相邻 qubit 对端点 ∈ [0, qubits_count) */
  a: number;
  b: number;
  /** 双比特门保真度 ∈ (0,1]；云端真机缺省 */
  tq_fidelity?: number;
}

export interface QpuTopology {
  layout: string;
  rows: number;
  cols: number;
  qubits: QubitInfo[];
  couplers: Coupler[];
  /** v1.4：云端拓扑的比特坐标（无 couplers/保真度时按此摆放坐标点）。
   * 索引对应 qubit id（logicalcloud topology.qubit_coordinates 镜像）。 */
  qubit_coordinates?: Array<[number, number]>;
}

export interface QpuMetrics {
  qubits_count: number;
  topology: QpuTopology;
}

/** §4 v1.2 CPU metrics：经典节点性能监控。 */
export interface CpuMetrics {
  cpu_cores: number;
  cpu_usage: number;
  memory_total_gb: number;
  memory_used_gb: number;
}

/** §4 v1.2 GPU metrics：显存与利用率（utilization 字段沿用为总利用率）。 */
export interface GpuMetrics {
  vram_total_gb: number;
  vram_used_gb: number;
}

/** metrics 按 kind 三形状可选（旧后端/畸形缺省 → 前端逐行降级隐藏）。 */
export type NodeMetrics = QpuMetrics | CpuMetrics | GpuMetrics;

export interface HardwareNode {
  id: string;
  kind: NodeKind;
  name: string;
  model: string;
  status: NodeStatus;
  /** ∈ [0,1] */
  utilization: number;
  capacity: number;
  /** §4 v1.2：监控数据（按 kind 形状不同；可缺省，前端降级） */
  metrics?: NodeMetrics;
  allocations: Allocation[];
}

/** §4 v1.2 租户角色：admin 可见管理分区（渠道/插件），user 隐藏（强制力在后端 403）。 */
export type TenantRole = 'user' | 'admin';

/** GET /api/v1/tenants/me —— 租户信息 + 用量/配额（字段名对齐后端 usage_snapshot） */
export interface TenantInfo {
  id: string;
  name: string;
  enabled: boolean;
  /** §4 v1.2：角色决定管理分界线；旧后端缺省按 user 降级（仅 UX 可见性） */
  role?: TenantRole;
  usage: {
    active_tasks: number;
    messages_today: number;
  };
  quota: {
    max_concurrent_tasks: number;
    max_messages_per_day: number;
  };
}

/** 防御式解析：未知/缺失角色降级为 user（最保守可见性）。 */
export function parseTenantRole(raw: unknown): TenantRole {
  return raw === 'admin' ? 'admin' : 'user';
}

/** POST /api/v1/conversations/{cid}/messages 请求体（v1.1：model_ref/thinking_level 可选覆盖；v1.3：attachment_ids）。 */
export interface SendMessageRequest {
  content: string;
  model_ref?: string;
  thinking_level?: ThinkingLevel;
  /** §5.2 v1.3：随消息发送的附件 id（未知/跨会话 id → 422） */
  attachment_ids?: string[];
}

/** POST /api/v1/conversations/{cid}/messages 的 202 响应 */
export interface SendMessageAck {
  message_id: string;
  run_id: string;
}

/** 会话详情 = Conversation + messages（GET /conversations/{cid}） */
export interface ConversationDetail extends Conversation {
  messages: Message[];
}

/** GET /api/v1/models 条目（v1.3 选择器列表：任意角色可读，不含管理细节） */
export interface ModelSummary {
  ref: string;
  provider: string;
  model: string;
  default_thinking: string;
  has_api_key: boolean;
}

/** GET /api/v1/hardware 响应 */
export interface HardwareResponse {
  nodes: HardwareNode[];
}
