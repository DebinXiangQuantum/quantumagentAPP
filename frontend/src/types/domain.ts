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
  created_at: string;
}

/** §4 ThinkingLevel（v1.1）——思考程度归一化枚举。 */
export type ThinkingLevel = 'off' | 'low' | 'high' | 'max';

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

/** §6 circuit 载荷 */
export interface CircuitOperation {
  id: string;
  gate: string;
  targets: number[];
  controls?: number[];
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

export interface HardwareNode {
  id: string;
  kind: NodeKind;
  name: string;
  model: string;
  status: NodeStatus;
  /** ∈ [0,1] */
  utilization: number;
  capacity: number;
  allocations: Allocation[];
}

/** GET /api/v1/tenants/me —— 租户信息 + 用量/配额（字段名对齐后端 usage_snapshot） */
export interface TenantInfo {
  id: string;
  name: string;
  enabled: boolean;
  usage: {
    active_tasks: number;
    messages_today: number;
  };
  quota: {
    max_concurrent_tasks: number;
    max_messages_per_day: number;
  };
}

/** POST /api/v1/conversations/{cid}/messages 请求体（v1.1：model_ref/thinking_level 可选覆盖）。 */
export interface SendMessageRequest {
  content: string;
  model_ref?: string;
  thinking_level?: ThinkingLevel;
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

/** GET /api/v1/hardware 响应 */
export interface HardwareResponse {
  nodes: HardwareNode[];
}
