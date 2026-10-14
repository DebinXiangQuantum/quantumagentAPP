# QuantumAgentApp 系统架构与前后端契约（v1）

> 本文档是前后端并行开发的**单一事实来源**（single source of truth）。
> API 路径、SSE 事件名、Artifact JSON 结构、配置键名、插件接口以此为准；
> 任何变更必须先改本文档再改代码，并在 change.log 记录。

## 1. 目标与范围

平台承载多类量子领域智能体（校准/波形、算法设计、容错程序生成……），但平台本身
**不实现领域算法**，只提供：对话交互、租户管理、任务编排（DAG）、并行调度、
异构硬件（QPU/GPU/CPU）注册与分配、统一 LLM Provider（OpenAI + Anthropic 两种
wire format + Mock）、SSE 实时事件。

非目标（原型阶段）：真实量子硬件驱动、持久化数据库（内存态 + 可选 JSON 快照）、
多进程部署。这些以接口边界的方式预留。

## 2. 总体架构

```
┌──────────────────────────── 前端 (React 18 + TS + Vite) ────────────────────────────┐
│  会话侧栏 │ 对话区(流式) │ 检查器: 硬件拓扑 / 任务DAG / 线路 / 结果直方图            │
└───────────────┬────────────────────────────────────────────────────────────────────┘
        REST /api/v1/*  +  SSE (EventSource)
┌───────────────┴──────────────────── 后端 (FastAPI, 包名 qap) ───────────────────────┐
│ api/routers: health agents tenants conversations tasks hardware events(SSE)          │
│ core: config(tomllib) │ errors │ ids                                                  │
│ tenancy: 租户注册表 + Bearer 鉴权 + 配额                                              │
│ agents: PluginRegistry │ Runtime(工具循环) │ providers(openai/anthropic/mock)         │
│ orchestrator: DAG 校验 │ Scheduler(asyncio 并行, 容量租约) │ runners                  │
│ hardware: NodeRegistry │ Allocator(租约) │ Simulator(利用率模拟)                      │
│ events: EventBus(asyncio 发布/订阅)                                                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

设计参照 [pi-agent-core](https://github.com/earendil-works/pi) 的"统一 LLM API"思路
（TypeScript 实现）；本平台后端为 Python（与兄弟项目 pulseagent/FTQP 一致，便于插件
直接接入），故以约 300 行自研薄层镜像其 Provider 抽象，不引入重框架。备选方案
（工程选择，非事实）：OpenAI Agents SDK、Pydantic AI——均比需求重，且在算力紧张
场景下依赖面过大。

## 3. 全局配置（config.toml）

见仓库根 [`config.toml`](../config.toml)。加载规则：

- 路径解析顺序：环境变量 `QAP_CONFIG` → `./config.toml`。
- 解析：Python 标准库 `tomllib`；校验用 Pydantic 模型，**任何缺键/类型不符/
  未知 provider/未知 kind/负数容量 → 启动即失败**（fail-fast，测试覆盖）。
- 密钥：配置中只存 `api_key_env`（环境变量名）；运行时缺失该环境变量时，
  对应模型仅在**被实际调用**时报错，不影响其他模型与 Mock。
- 演示租户 `demo-key` 可被 `QAP_DEMO_API_KEY` 覆盖（避免示例值被误当作真实密钥）。

键名契约（节选，完整见 config.toml 注释）：
`server.{host,port,cors_origins}` · `models.<ref>.{provider,model,base_url,api_key_env,timeout_seconds}`
· `agents.default_model_ref` · `agents.builtin.<id>.{enabled,model_ref}` ·
`hardware.{simulated,tick_seconds}` · `hardware.nodes[].{id,kind,name,model,capacity}` ·
`scheduler.{max_parallel_steps,step_timeout_seconds,retry_failed_steps}` ·
`tenancy.{default_tenant, tenants[].{id,name,api_key,max_concurrent_tasks,max_messages_per_day}}`

**v1.1 渠道池与本地覆盖**：
- `[models.<ref>]` 新增可选键 `default_thinking`（`"off"|"low"|"high"|"max"`，
  缺省 `"high"`）——该渠道的默认思考程度；主页/每条消息可再覆盖。
- **加载顺序 = 配置覆盖（overlay）**：`config.toml`（提交入库的默认渠道池）为
  基底，若存在 `config.local.toml`（**已被 .gitignore 排除**）则深合并覆盖其上
  （models 字典按键覆盖/新增、标量直接覆盖）。管理平台（§5 admin API）的
  "提供商渠道"编辑即写回 `config.local.toml`——因此**内联 api_key 只会落在
  该 gitignored 文件**，仓库永不出现密钥。
- GLM 渠道（OpenAI 兼容，实测 2026-10-13）：base_url
  `https://open.bigmodel.cn/api/paas/v4`，密钥经 `api_key_env = "GLM_API_KEY"`
  从环境读取；可用模型实测含 glm-4.5/4.5-air/4.6/4.7/5/5-turbo/5.1/5.2/
  **5.3/5.3-flash/5.3-flashx**。思考控制（v1.1 实测修正，官方文档
  docs.bigmodel.cn/cn/guide/capabilities/thinking）：glm-5.3 系**只接受**
  `thinking.type = "enabled"`（`disabled` 报服务端错误码 1210；实测
  `low/high/max` 直接作 type 值同样报 1210），思考强度经**独立顶层参数**
  `reasoning_effort ∈ low|high|max`（缺省 max）；其思考内容以流式
  `delta.reasoning_content` 增量返回（OpenAI 扩展字段）。

## 4. 领域模型（序列化 JSON 契约）

```jsonc
// AgentInfo —— 已注册的 Agent 插件
{ "id": "algorithm-designer", "name": "量子算法设计", "description": "…",
  "capabilities": ["problem-modeling","circuit-synthesis"], "model_ref": "default",
  "builtin": true }

// Conversation / Message（v1.1：agent_id 可缺省 = "orchestrator" 编排入口；
// Message 新增 reasoning 字段承载思考过程全文，可为空串）
{ "id": "c-1", "title": "…", "agent_id": "orchestrator",
  "tenant_id": "demo", "created_at": "2026-10-13T06:00:00Z" }
{ "id": "m-7", "conversation_id": "c-1", "role": "user"|"assistant",
  "content": "文本", "reasoning": "思考过程文本（可为空串）",
  "agent_id": "orchestrator",
  "artifacts": [ /* Artifact[]，见 §6 */ ], "created_at": "…" }

// ThinkingLevel —— 思考程度（v1.1）："off" | "low" | "high" | "max"

// TenantInfo（v1.2 显式化）——GET /tenants/me；role 决定管理分界线
{ "id": "demo", "name": "Demo 租户", "enabled": true, "role": "user"|"admin",
  "usage": { "active_tasks": 0, "messages_today": 12 },
  "quota": { "max_concurrent_tasks": 2, "max_messages_per_day": 1000 } }

// Task / Step —— 编排单位
{ "id": "t-1", "conversation_id": "c-1", "tenant_id": "demo", "name": "VQE 全流程",
  "status": "pending"|"running"|"succeeded"|"failed"|"cancelled",
  "steps": [ /* Step[] */ ], "created_at": "…" }
{ "id": "s-0", "name": "分子积分计算", "kind": "classical"|"quantum"|"agent",
  "status": "pending"|"running"|"succeeded"|"failed"|"cancelled",
  "node_id": "cpu-node-0",            // 分配到的硬件节点；未调度为 null
  "depends_on": [],                    // 前置 Step id 列表
  "started_at": null, "finished_at": null,
  "detail": "人类可读的执行说明", "error": null }

// HardwareNode / Allocation
{ "id": "gpu-a800-0", "kind": "gpu"|"qpu"|"cpu", "name": "A800 #0",
  "model": "NVIDIA A800 80GB", "status": "online"|"offline",
  "utilization": 0.37,                 // ∈ [0,1]，模拟器驱动
  "capacity": 1,                       // 最大并行租约数
  "metrics": { /* v1.2 按 kind 不同的监控数据，见下；可缺省，前端降级 */ },
  "allocations": [ { "task_id": "t-1", "step_id": "s-2",
                     "agent_id": "algorithm-designer", "leased_at": "…" } ] }
```

**v1.2 `HardwareNode.metrics`（性能监控与 QPU 拓扑数据）**：

```jsonc
// kind=qpu：拓扑结构 + 逐比特/逐耦合器保真度（原型为模拟数据：文献合理
// 区间随机生成并随 tick 缓慢漂移 —— simulated results，非硬件观测）
"metrics": {
  "qubits_count": 20,
  "topology": {
    "layout": "grid",                  // 原型：rows×cols 矩形网格
    "rows": 4, "cols": 5,
    "qubits": [ { "id": 0,              // id = row*cols + col
                  "t1_us": 47.2, "t2_us": 31.5,      // 单位 µs，> 0
                  "readout_fidelity": 0.978,          // 读出保真度
                  "sq_fidelity": 0.9993 } ],          // 单比特门保真度
    "couplers": [ { "a": 0, "b": 1, "tq_fidelity": 0.9912 } ] } } // 网格相邻对
// kind=cpu：经典节点性能监控
"metrics": { "cpu_cores": 64, "cpu_usage": 0.37,
             "memory_total_gb": 256.0, "memory_used_gb": 98.4 }
// kind=gpu：显存与利用率（utilization 字段沿用为总利用率）
"metrics": { "vram_total_gb": 80.0, "vram_used_gb": 12.6 }
```

v1.2 不变量（测试必须覆盖）：所有 fidelity ∈ (0,1]；`t1_us/t2_us > 0` 且
`t2_us ≤ 2*t1_us`（物理合理性上界）；`memory_used_gb ≤ memory_total_gb`、
`vram_used_gb ≤ vram_total_gb`；usage ∈ [0,1]；coupler 端点 ∈
[0, qubits_count) 且为网格相邻对；grid 布局 qubit id 与 (row,col) 一一对应。
模拟区间（工程选择，标注为模拟）：T1 20–80µs、T2 10–60µs、readout
0.95–0.995、1Q 0.995–0.9999、2Q 0.98–0.995；漂移幅度每 tick ≤ 0.0002。

不变量（测试必须覆盖）：
1. Task 为 DAG：`depends_on` 传递闭包无环、无未知 id、无重复 step id。
2. counts Artifact：`sum(counts.values()) == shots`；比特串长度 == `qubits`；
   值非负、shots > 0。
3. `utilization ∈ [0,1]`；单节点活动租约数 ≤ `capacity`。
4. 所有 id 前缀固定（`c-` `m-` `t-` `s-` `a-`）且全局唯一。

## 5. REST API v1 契约

鉴权：除 `/health` 外均需 `Authorization: Bearer <api_key>`；
**SSE 修订**：浏览器 `EventSource` 无法携带自定义请求头（MDN 限制），故两个
流端点在 Authorization 头**缺失**时接受 `?api_key=` 查询参数兜底（头存在时
以头为准，不允许用参数"抢救"坏头）。已知权衡：查询参数可能进入访问日志，
生产部署应换一次性 ticket 或 Cookie（§13）。
错误：401 未知/缺失 Key；403 租户禁用；404 资源不存在且**不得跨租户访问**；
422 请求体畸形；429 超配额（`Retry-After` 头，秒）；错误体统一
`{"error": {"code", "message"}}`。

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/v1/health` | — | `{"status":"ok","version":"…"}` |
| GET | `/api/v1/agents` | — | `AgentInfo[]` |
| GET | `/api/v1/tenants/me` | — | 租户信息 + 用量/配额 |
| GET | `/api/v1/conversations` | query: `?limit=` | `Conversation[]` |
| POST | `/api/v1/conversations` | `{"title":"…"}`（`agent_id` 可选，缺省 `orchestrator`） | `Conversation`(201) |
| GET | `/api/v1/conversations/{cid}` | — | `Conversation` + `messages: Message[]` |
| POST | `/api/v1/conversations/{cid}/messages` | `{"content":"…","model_ref":"glm-5.3-flash","thinking_level":"high"}`（后两项可选覆盖） | `202 {"message_id","run_id"}` |
| GET | `/api/v1/admin/models` | — | `{"models": ModelChannel[]}`（v1.1 管理平台渠道池） |
| PUT | `/api/v1/admin/models/{ref}` | `ModelChannelInput` | `ModelChannel`(200)，并持久化到 `config.local.toml` |
| DELETE | `/api/v1/admin/models/{ref}` | — | `204`（删除本地覆盖渠道；基底渠道不可删 → 409） |

**v1.3 附件（composer ＋ 按钮）**：
- `POST /api/v1/conversations/{cid}/attachments`（multipart `file`；单文件 ≤ 8MB；
  超限/空文件/非 multipart → 422）→ `201 {"id":"att-1","name","mime","size",
  "kind":"image"|"text"|"file"}`；kind 判定：mime `image/*` → image；
  `text/*` 或扩展名 {.md,.txt,.py,.json,.toml,.csv,.yaml,.ts,.js} → text；
  其余 file。内存存储（原型）。
- `GET /api/v1/attachments/{id}/raw` → 文件字节（同租户隔离）。
- `Message.attachments: AttachmentMeta[]`（可选，缺省 []）；
  `POST …/messages` 请求体新增 `attachment_ids: []`（未知/跨会话 id → 422）。
- Provider 行为：text 内容截断注入 user 上下文；image 以 openai `image_url`
  （data URL）/ anthropic image block 发送（**需视觉模型**，文本模型返回的
  provider 错误经 SSE error 事件内联展示）；mock 仅展示。

**v1.2 管理权限与租户角色**：
- `tenancy.tenants[].role ∈ {"user","admin"}`（缺省 `user`；非法值启动拒绝）；
  `/tenants/me` 返回 `role`。
- 全部 `/api/v1/admin/*` 端点（models 渠道 CRUD、plugins 安装/启停/卸载）
  要求 `role = admin`，否则 **403** `{"error":{"code":"forbidden"}}`。
- 前端据 `role` 决定管理分区可见性（普通用户隐藏渠道/插件分区）——
  可见性只是 UX，**强制力在后端**。

**v1.1 ModelChannel（渠道池条目，密钥脱敏）**：

```jsonc
// GET 返回（绝不回传密钥明文，只报"是否已设置"）
{ "ref": "glm-5.3-flash", "provider": "openai", "model": "glm-5.3-flash",
  "base_url": "https://open.bigmodel.cn/api/paas/v4",
  "api_key_env": "GLM_API_KEY",      // 与 api_key_inline 二选一（见 PUT）
  "has_api_key": true,                // env 已解析到非空值，或本地文件内联了密钥
  "default_thinking": "high", "timeout_seconds": 120 }
// PUT 请求体（ModelChannelInput）：上字段除 has_api_key 外均可写；
// 额外接受 "api_key_inline": "<明文>" —— 只写入 config.local.toml，响应与
// GET 中同样只体现为 has_api_key: true。provider ∈ openai|anthropic|mock，
// default_thinking ∈ off|low|high|max，非法值 422。
```
| GET | `/api/v1/conversations/{cid}/stream` | query: `?after=<eventId>` | SSE 流（§7） |
| GET | `/api/v1/tasks` | query: `?conversation_id=` | `Task[]` |
| GET | `/api/v1/tasks/{tid}` | — | `Task` |
| GET | `/api/v1/hardware` | — | `{"nodes": HardwareNode[]}` |
| GET | `/api/v1/events` | — | 全局 SSE（task/hardware 事件） |

`POST …/messages` 语义：立即落库用户消息并返回 202，Agent 运行异步执行，
产物经该会话 SSE 流推送。返回的 `message_id` 是后端**预创建的 assistant
消息 id**（SSE 增量与完成事件的归属者）——前端不得将其用作本地用户消息 id
（否则 `message.completed` 按 id 去重会吞掉 assistant 消息与 artifacts），
用户消息应以本地临时 id 乐观上屏，刷新后以后端落库数据为准。

## 6. Artifact 契约（消息携带的可视化数据）

统一信封：`{ "id": "a-1", "type": "<类型>", "title": "…", "payload": {…} }`。
前端按 `type` 分发渲染器；**未知 type 必须优雅降级**为可展开的原始 JSON 卡片，
不得崩溃。载荷必须通过后端校验（非法载荷在生成侧即拒绝）。

```jsonc
// type: "circuit" —— 量子线路（gate 级）
{ "qubits": 2, "operations": [
    {"id":"op-0","gate":"H","targets":[0]},
    {"id":"op-1","gate":"CNOT","controls":[0],"targets":[1]},
    {"id":"op-2","gate":"MEASURE","targets":[0,1]} ] }
// 约束：qubits ∈ [1,32]；targets/controls ⊂ [0,qubits)；gate 非空；
//       单量子门 targets 长度 1；MEASURE 无 controls。

// type: "counts" —— 测量计数
{ "shots": 1024, "qubits": 2, "counts": {"00": 498, "11": 512, "01": 8, "10": 6} }
// 约束：§4 不变量 2；键为 0/1 串且长度 == qubits。

// type: "waveform" —— 校准波形
{ "sample_rate_ns": 1.0, "unit": "mV", "channels": [
    {"label":"Q0 I", "samples":[0.0, 0.12, /*…*/]},
    {"label":"Q0 Q", "samples":[…]} ] }
// 约束：samples 长度 ∈ [2, 65536] 且全部有限（isfinite）；采样率 > 0。
```

## 7. SSE 事件契约

传输：`text/event-stream`，格式 `event: <name>\ndata: <json>\n\n`；
每 15s 发 `event: ping`。会话流事件按 `seq` 单调递增，客户端可用 `?after=` 断线续传
（原型：内存缓存最近 1024 条）。

| event | data 载荷 |
|---|---|
| `message.delta` | `{conversation_id, message_id, delta, seq}` |
| `message.reasoning` | `{conversation_id, message_id, delta, seq}`（v1.1：思考过程增量，先于正文 delta 到达） |
| `message.completed` | `{conversation_id, message_id, artifacts, reasoning}`（reasoning 为思考全文，可为空串） |
| `task.updated` | `{task_id, status, steps}`（每次状态迁移全量推送该 Task） |
| `hardware.updated` | `{nodes}`（利用率/分配变化时推送全量节点） |
| `error` | `{code, message}`（如 provider 超时、步骤失败摘要） |

## 8. Agent 插件接口

平台内置三个**演示插件**（`algorithm-designer` / `calibration` / `echo`），
接口即接入范式；后续 pulseagent 等以同构方式接入：

```python
class AgentPlugin(Protocol):
    id: str; name: str; description: str
    capabilities: Sequence[str]
    model_ref: str            # 指向 [models.<ref>]
    system_prompt: str
    tools: Sequence[ToolSpec] # 领域工具声明（JSON Schema 参数）
```

- 清单对齐 [agent-plugins.org schema 1.0.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
  （与 pulseagent/plugin.json 同构）：外部插件目录（`agents.plugins_dir`）下含
  `plugin.json` + Python 入口即被发现加载；原型阶段外部加载可先抛"未实现"。
- **v1.1 内置编排 Agent（`orchestrator`）**：会话不再要求用户选择具体 Agent
  （`agent_id` 缺省即 orchestrator）。其系统提示描述平台能力与可用专家清单，
  由模型按任务自主决定调用哪个专家；独占平台工具 `dispatch_agent`。
- **v1.1 插件安装机制（对齐 pi agent 的扩展加载范式；pi 为 TS 扩展目录自动
  发现，本平台为 Python 等价物）**：
  - 安装目标目录 = `agents.plugins_dir`（缺省 `./plugins/`，**gitignored**，
    运行时安装内容不入库）；安装 = 复制来源目录（本地路径）到目标目录。
  - `plugin.json`（agent-plugins.org 1.0.0 基础字段 name/version/description）
    扩展键 `"qap": {"entry": "<module>:<factory>"}`——`importlib` 导入工厂
    函数（签名 `() -> AgentPlugin`，抛异常则该插件注册为 broken 并在 API
    返回错误详情，**不拖垮平台**）。
  - 管理端点：`POST /api/v1/admin/plugins/install {"source_path": "…"}`
    （重名 409；清单缺失/entry 无法导入 → 422 带原因）；
    `GET /api/v1/admin/plugins`（含 builtin 与 installed、enabled、broken 原因）；
    `PUT /api/v1/admin/plugins/{id} {"enabled": bool}`（状态持久化到
    config.local.toml `[agents.plugin_state]`）；`DELETE …/{id}` 卸载
    （builtin → 409）。
  - 启动时自动扫描 plugins_dir 并按持久化状态恢复 enabled/disabled。
- **平台级工具**（所有 Agent 可用，Runtime 注入）：
  `emit_artifact(artifact)` 附加可视化产物到当前消息；`submit_task(name, steps)`
  提交 DAG；`query_hardware()` 返回节点与分配；
  **`dispatch_agent(agent_id, instruction)`（v1.1，仅 orchestrator）**——以目标
  专家 Agent 的 system_prompt+tools 运行一次子推理，返回其回复文本与 artifacts
  （自动附加到当前消息）；**嵌套深度 = 1**（子 Agent 不可再 dispatch，防递归）。
- Runtime 工具循环：`system_prompt + 历史 → provider 流式 → tool_call → 执行 →
  回填 → 直至纯文本`；每轮 text delta 实时进 SSE。

## 9. LLM Provider 抽象

```python
class LLMProvider(Protocol):
    async def stream(self, req: CompletionRequest) -> AsyncIterator[ProviderEvent]
# ProviderEvent = text_delta{text} | tool_call{name, arguments} | error{message}
```

| provider | 端点 | 鉴权/头 | 流式解析要点 |
|---|---|---|---|
| `openai` | `POST {base_url}/chat/completions`，`stream:true` | `Authorization: Bearer $KEY` | SSE `data:` 行 → `choices[0].delta.content` 与 `delta.tool_calls`（增量拼接 arguments）；**v1.1：`delta.reasoning_content`（GLM/DeepSeek 式思考增量）→ `thought_delta` 事件** |
| `anthropic` | `POST {base_url}/v1/messages`，`stream:true` | `x-api-key`、`anthropic-version: 2023-06-01` | 事件 `content_block_delta`（`text_delta` / `input_json_delta` 拼接工具入参；`thinking_delta` → `thought_delta`） |
| `mock` | 进程内 | — | 脚本化：演示场景依次产出 reasoning/text/tool_call，驱动 §10 全链路 |

**v1.1 思考程度（ThinkingLevel）→ 请求参数映射**（归一化枚举 `off|low|high|max`；
openai 列为 GLM 实测形状——2026-10-13 冒烟修正：强度走独立
`reasoning_effort` 参数，`thinking.type` 只接受 `enabled`/`disabled`）：

| ThinkingLevel | openai 兼容（GLM） | anthropic |
|---|---|---|
| `off` | `thinking: {"type":"disabled"}`（glm-5.3 系拒绝，服务端错误码 1210 会透传为 error 事件） | 不发送 thinking 块 |
| `low` | `thinking: {"type":"enabled"}` + `reasoning_effort: "low"` | `thinking: {"type":"enabled","budget_tokens":2048}` |
| `high` | `… enabled` + `reasoning_effort: "high"` | `… budget_tokens:8192` |
| `max` | `… enabled` + `reasoning_effort: "max"` | `… budget_tokens:16384` |

取值优先级：消息级 `thinking_level` > 会话/请求 `model_ref` 渠道的
`default_thinking` > `"high"`。`ProviderEvent` 新增 `thought_delta{text}`
（思考增量），Runtime 将其作为 `message.reasoning` SSE 事件转发并累加入
`Message.reasoning` 全文。

测试策略：openai/anthropic 两个 provider 的解析逻辑用 httpx `MockTransport`
回放**规范样例与畸形样例**（非法 JSON 行、流中断、非 200），不发真实网络请求。

## 10. 端到端演示链路（验收基线）

Mock Provider 脚本必须驱动如下可观察行为（集成测试断言）：

1. 创建会话（algorithm-designer）→ 发消息 → SSE 依序收到
   `message.delta…` → `message.completed`（含 circuit + counts artifacts）。
2. Assistant 在流中调用 `submit_task`：3 步 DAG（classical: 分子积分 →
   quantum: VQE 线路执行 → classical: 结果后处理），依赖链式。
3. Scheduler 依容量分配节点：quantum 步占 `qpu-quanta-20q`，classical 步落
   `cpu-node-0`；`task.updated` 逐步推送状态迁移。
4. `hardware.updated` 反映 allocation —— **前端能回答"哪个 Agent 在用哪块 GPU"**。
5. 全程零真实 LLM 调用、零真实硬件依赖。

## 11. 测试策略（对应用户质量规则）

- 不变量：§4 全部（无环、容量、计数守恒、utilization 界）。
- 非法输入拒绝：坏 config、坏 artifact、坏 DAG、非有限 float、越界 qubit 索引。
- 负样本/噪声：provider 流中断、步骤超时、节点 offline、租户超配额(429)、
  跨租户访问(404)、未知 Bearer(401)。
- 可观察行为：SSE 事件顺序与 seq 单调；调度串行化（capacity=1 的 GPU 两步不重叠）。

## References

- pi / pi-agent-core（统一 LLM API 设计参照，MIT）: https://github.com/earendil-works/pi
- OpenAI Chat Completions（流式 wire format 事实来源）: https://platform.openai.com/docs/api-reference/chat/streaming
- Anthropic Messages Streaming（流式 wire format 事实来源）: https://docs.anthropic.com/en/api/messages-streaming
- FastAPI（Web 框架官方文档）: https://fastapi.tiangolo.com/
- Server-Sent Events（MDN，事件格式与 EventSource 行为）: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- Python tomllib（TOML 解析事实来源）: https://docs.python.org/3/library/tomllib.html
- agent-plugins.org plugin.schema.json（插件清单对齐目标）: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- Qiskit Visualization（线路绘制约定参考：qubit 横排、门格点、测量表针）: https://qiskit.org/documentation/apidoc/visualization.html

> 声明：以上文献支撑的是**协议与约定事实**（API 行为、事件格式、绘制惯例）；
  具体模块划分、内存态存储、模拟硬件等均为**工程选择**，由本仓库测试与
  change.log 记录佐证，引用不构成对实现的证明。
