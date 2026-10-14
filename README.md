# QuantumAgentApp — 异构量子智能体平台（原型）

QuantumAgentApp 是一个**前后端全栈平台原型**，用于承载量子领域的一组智能体（Agent）：
量子校准 / 波形校准 Agent、量子算法设计 Agent、容错量子程序生成 Agent（基于容错编程语言）等。
平台本身**不实现**这些领域 Agent，而是提供一套统一的接入范式：

- **对话式前端**：以聊天为交互主形态，同时内嵌专业可视化面板——量子线路图、
  测量结果直方图、任务 DAG 执行视图、异构硬件拓扑（QPU / GPU / 经典 CPU 节点）、
  以及"哪个 Agent 正在占用哪块 GPU"的分配详情。视觉参照 Q-CTRL Boulder Opal 一类
  专业科学软件的信息密度与精致度（见 `docs/design.md`）。
- **平台后端**：租户管理（API Key 鉴权、配额）、任务编排（DAG 建模与校验）、
  并行调度（按硬件容量租约调度）、硬件注册表（量子/经典异构节点）、
  Agent 运行时（统一 LLM Provider 抽象，同时支持 **OpenAI 与 Anthropic 两种
  wire format**，内置零算力消耗的 Mock Provider）、SSE 实时事件总线。
- **全局配置**：一切平台配置集中于仓库根目录 `config.toml`（各模型的 Base URL、
  provider 格式、硬件节点清单、调度参数、租户配额等）；密钥一律通过
  `api_key_env` 指向环境变量，**绝不写入仓库**。

架构契约（API / SSE 事件 / Artifact JSON / 插件接口 / 配置键名）的完整定义见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；前端设计系统与验收标准见
[`docs/design.md`](docs/design.md)；开发流程规范见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

## 快速开始

### 后端（Python 3.11+，推荐 3.12）

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest                                   # 全部测试
PYTHONPATH=src uvicorn qap.main:app --reload   # 默认读取仓库根 ../config.toml
curl http://127.0.0.1:8000/api/v1/health
```

默认配置使用 Mock Provider（`provider = "mock"`），无需任何真实 API Key
即可完整演示：创建会话 → 流式回复 → 产出线路/计数 Artifact → 提交 DAG 任务 →
调度到配置的 GPU/QPU 节点 → SSE 推送硬件分配变化。

### 前端（Node 18+）

```bash
cd frontend
npm install
npm run build        # 生产构建
npm test             # vitest 单元/组件测试
VITE_USE_MOCK=1 npm run dev    # Mock 模式：后端未启动也可完整演示界面
npm run dev          # 连接 http://127.0.0.1:8000 的真实后端
```

## 仓库结构

```
.
├── config.toml          # 全局唯一配置文件（含各模型 Base URL；密钥走环境变量）
├── change.log           # 变更日志（每次提交必须更新）
├── docs/
│   ├── ARCHITECTURE.md  # 系统架构与前后端契约（单一事实来源）
│   ├── design.md        # 前端设计系统与视觉验收标准
│   └── DEVELOPMENT.md   # 分支/worktree/切片/TDD/提交规范
├── backend/             # feat/backend 分支维护（FastAPI + Python 3.11+）
└── frontend/            # feat/frontend 分支维护（React 18 + TS + Vite）
```

## 后端 (Backend)

*本节由 `feat/backend` 分支的开发切片维护更新：模块清单、运行方式、测试结果。*

**S1（配置加载器）**：`backend/src/qap/core/config.py` 实现契约 §3——
路径解析 `QAP_CONFIG` → CWD `./config.toml` → 向上探测；`tomllib` 解析 +
Pydantic v2 严格校验（`extra=forbid`，缺键/类型错/未知 provider/未知 kind/
负容量/悬空 model_ref 引用均启动 fail-fast）；密钥只经 `api_key_env` 读环境
变量（`AppConfig.resolve_api_key`，缺失仅影响该模型被实际调用时）；
`demo-key` 可被 `QAP_DEMO_API_KEY` 覆盖。同切片含 `core/errors.py`（统一
错误码基类）与 `core/ids.py`（`c-/m-/t-/s-/a-/run-` 前缀 id 生成器）。
测试：`backend/tests/test_config.py`（26 用例：合法加载、密钥规则、
15 类畸形配置 fail-fast、TOML 语法错、路径探测）。

**S2（领域模型 + Artifact 校验 + 事件总线）**：
- `qap/domain/models.py`：契约 §4 全部序列化模型（AgentInfo/Conversation/
  Message/Step/Task/HardwareNode/Allocation/Artifact 信封），id 前缀形状校验、
  utilization ∈ [0,1] 且有限（NaN/±inf 拒绝）、Artifact 载荷构造期校验、
  未知 type 放行（前端降级渲染的契约配合）。
- `qap/domain/artifacts.py`：circuit/counts/waveform 三类载荷的完整约束
  （量子比特下标、门元数、计数守恒、采样有限性等），非法载荷生成侧拒绝。
- `qap/events/bus.py`：asyncio 发布/订阅总线——全局单调 seq（SSE 帧 id 即
  seq，`?after=` 续传游标）、内存回放缓存最近 1024 条、会话流/全局流两级
  过滤、慢客户端有界队列丢最旧。
- `qap/core/clock.py`：契约格式 UTC 时间戳。
- 测试：test_domain_models / test_artifacts / test_events_bus（新增 65 用例：
  不变量、非法输入、缓冲驱逐、会话隔离、队列溢出等）。

**S3（租户/鉴权/配额）**：`qap/tenancy/service.py`——API Key → 租户上下文
（缺失/未知 Key → 401 语义，禁用 → 403 语义，支持运行时启停）；消息配额
按 UTC 自然日惰性重置（超限 QuotaError 携带距午夜的 Retry-After 秒数）；
并发任务配额（提交登记/终态释放，超限 429）；`usage_snapshot` 输出
GET /tenants/me 的用量视图。测试 15 用例（含时钟注入的跨日重置与多租户
额度隔离）。

**S4（硬件注册表 + 分配器 + 利用率模拟器）**：
- `qap/hardware/registry.py`：`[[hardware.nodes]]` 的权威运行时副本，
  snapshot 深拷贝隔离内部状态；utilization 赋值期校验（NaN/±inf/越界拒绝）。
- `qap/hardware/allocator.py`：容量租约——kind 匹配 + online 过滤 +
  负载比择优；`try_lease`（满返 None）与 `lease`（满抛 `LeaseDenied` 可等待 /
  无在线节点抛不可等待 `SchedulingError`）区分两种失败；租约变化发布
  `hardware.updated`（载荷含 agent_id，支撑"哪个 Agent 在用哪块 GPU"）。
- `qap/hardware/simulator.py`：负载相关的一阶惯性 + 噪声模型，构造性保证
  utilization ∈ [0.05,0.98]；数值变化才发帧；rng 可注入保证确定性测试。
- 领域模型 Step/HardwareNode 开启 `validate_assignment`（运行时改写也不变量成立）。
- 测试 21 用例（容量不变量、offline 负样本、两种分配失败语义、事件载荷、
  模拟器生命周期与确定性）。

**S5（DAG 校验 + 调度器）**：
- `qap/orchestrator/dag.py`：通用 DAG 校验（重复 id/未知依赖/自环/Kahn
  检测成环）+ 提交期 StepSpec（depends_on 用前序下标，结构性无环）+
  `build_steps`（下标 → 全局唯一 `s-` id）。
- `qap/orchestrator/scheduler.py`：asyncio 编排循环（事件唤醒 + 轮询兜底）——
  kind→节点映射（classical→cpu / quantum→qpu / agent→gpu）、容量租约排队、
  全局 max_parallel_steps 计数、step_timeout_seconds 步超时（failed + 下游
  级联 cancelled + 独立分支照常）、retry_failed_steps 单次重试；每次状态迁移
  发布全量 `task.updated`；终态触发回调（配额释放接缝）。
- `qap/orchestrator/runners.py`：模拟执行器（按 kind 缺省时长，
  `QAP_SIM_STEP_SECONDS` 可缩放；`never_finish_step` 供超时负样本）。
- 测试 24 用例（环/自环/重复 id 拒绝、3 步演示链、capacity=1 GPU 两步
  串行不重叠、全局并行峰值 ≤ 上限、超时级联、offline 直接失败、容量等待、
  独立分支存活、重试恢复、事件 seq 单调）。

**S6（三 Provider 流式解析）**：`qap/agents/providers/`
- `base.py`：CompletionRequest（provider 无关中间消息表示）/ ProviderEvent
  四态（TextDelta / ToolCall / ProviderErrorEvent / TurnCompleted）/ LLMProvider
  Protocol；错误一律事件化，绝不外抛网络异常。
- `openai_provider.py`：chat/completions 流式——`delta.content` 文本增量、
  `delta.tool_calls` 按 index 分片拼接 arguments、`[DONE]`/finish_reason 终止；
  非 200/非法 JSON/流中断 → ProviderErrorEvent。
- `anthropic_provider.py`：messages 流式——`content_block_delta` 的
  text_delta 与 input_json_delta 拼接、content_block_stop 产完整 ToolCall、
  message_stop 终止；x-api-key + anthropic-version 头；tool_result 块翻译。
- `mock_provider.py`：剧本化（agent_id → 轮列表，run_key 推进游标），内置
  §10 演示剧本（文本 + emit_artifact(circuit/counts) + submit_task(3 步 DAG)
  + 收束文本）、calibration 波形剧本、echo 回声、error 注入。
- `factory.py`：ModelConfig → Provider；密钥闭包"调用时读环境变量"。
- 测试 25 用例（规范/畸形样例回放、头与请求体形状、剧本推进与隔离、
  演示产物载荷自证）。

**S7（插件注册 + 平台工具 + Runtime 工具循环）**：
- `qap/agents/plugins.py`：AgentPlugin Protocol（§8）+ 三个内置演示插件
  （algorithm-designer/calibration/echo）+ PluginRegistry（配置启停与
  model_ref 覆盖、外部插件目录按契约抛"未实现"）。
- `qap/agents/tools.py`：平台工具三件套——emit_artifact（§6 生成侧校验）、
  submit_task（配额登记→入库→调度）、query_hardware（分配视图）；
  工具错误结构化 JSON 回给模型（可自纠错），未知工具抛 ValidationFailed。
- `qap/agents/runtime.py`：工具循环——TextDelta 实时 message.delta、
  ToolCall 执行回填（assistant.tool_calls + tool 消息）直至纯文本轮；
  ProviderError → SSE error + 部分文本收束；MAX 8 轮安全上限；
  收束统一发布 message.completed（含 artifacts）。
- `qap/domain/store.py`：会话/消息/任务内存存储（跨租户一律 404 语义）。
- 测试 18 用例（演示链路可观察行为、配额/坏载荷/坏 DAG 结构化错误、
  provider 故障收束、轮次上限、SSE 顺序）。

**S8（全部路由 + SSE + 端到端集成）**：
- `qap/api/`：state.py 组装根（AppConfig → 全部服务，任务终态回调释放租户
  并发额度）；deps.py Bearer 鉴权依赖；errors.py QapError→HTTP 映射
  （401/403/404/422/429+Retry-After，统一 `{"error":{code,message}}` 体）；
  sse.py 帧构造（id=seq / event / data）+ 流生成器（回放去重、15s ping、
  断开注销订阅）。
- `qap/api/routers/`：契约 §5 全部端点——health（免鉴权）、agents、
  tenants/me、conversations（创建 201/列表 ?limit/详情含 messages/
  POST messages 202+异步运行/SSE 流 ?after=）、tasks（?conversation_id=）、
  hardware、events（全局 SSE）。
- `qap/main.py`：create_app（lifespan 启停模拟器、CORS 白名单、异常
  处理器）；模块级 `app` 供 `uvicorn qap.main:app`。
- 集成测试 21 用例（§10 五步断言 + 401/403/404/422/429 负样本 + 跨租户
  隔离 + ?after= 续传 + 全局流过滤；SSE 读取走原生 ASGI——httpx 0.28
  ASGITransport 不支持无限流，测试 helper 已注明）。
- 补充 `tests/test_sse_format.py`（帧格式/15s 心跳/断开注销订阅/回放-实时
  去重的单元级断言）。

**DoD 冒烟（2026-10-13，全绿）**：全新 venv `pip install -e ".[dev]"` 后
`pytest` **219 passed**；`PYTHONPATH=src uvicorn qap.main:app` 启动后
curl 走通 §10 链路——health 返回 `{"status":"ok"}`；创建会话+发消息（202
含 message_id/run_id）；SSE 观察到 4×`message.delta` → `message.completed`
（circuit+counts artifacts）→ 9×`task.updated`（至 succeeded）→
22×`hardware.updated`（租约含 agent_id，完成后清空）；3 步任务中 quantum
步落 `qpu-quanta-20q`、classical 步落 `cpu-node-0`；`?after=` 续传只补新
事件；全局流只含 task/hardware；利用率模拟器驱动 utilization∈[0,1]；
未知会话流 404；免鉴权端点仅 health，无 Bearer 一律 401。

**集成修订（2026-10-13，main）**：浏览器 `EventSource` 无法携带 Authorization
头，`require_tenant` 增加 `?api_key=` 查询参数兜底（头缺失时生效，头存在时
以头为准）；集成测试新增 4 用例（全局/会话流查询参数鉴权、坏参数 401、
头优先级），全量 **223 passed**。契约 §5 已同步修订。

**v1.1（2026-10-13，main）**：渠道池（config.local.toml 覆盖层）+ admin API、
ThinkingLevel 与思考流（message.reasoning）、orchestrator 编排 Agent +
dispatch_agent、插件安装全生命周期；真实 GLM 冒烟走通全链路（详见 change.log）。
`GET /admin/plugins` 含 source/version/broken_reason。pytest 304 passed。

**v1.3（2026-10-14，main）**：硬件 metrics（10 QPU 网格拓扑保真度、GPU VRAM、
CPU/内存）、步骤实测 profile（真实计算负载 + perf_counter/tracemalloc，
dispatch 子任务自动挂接）、租户角色（/admin/* 403 强制）、附件上传与注入、
`GET /api/v1/models` 用户级选择器列表。pytest 418 passed。

**v1.4/v1.5（2026-10-14，main）**：logicalcloud 真机执行（5 台实拉、排队外显、
真实 counts artifact cloud-observed）；model_ref="default" 保留别名（修复专家
误走 mock 剧本）；模糊节点归一化（离线诚实报错/未知兜底自动选+备注）；
电路契约 v1.5（params 角度双轨、RZZ 门与 CX·RZ·CX 分解、测量后不变量）。
pytest 500 passed。真实 E2E：H₂ 问题→GLM 自选 VQE+UCCSD→真机任务（模糊
节点 bug 由真实测试暴露并修复）。

**B1（v1.1 渠道池与配置覆盖层）**：
- `qap/core/config.py`：加载顺序改为 **config.toml（基底）← config.local.toml
  （同目录，gitignored）深合并**——dict 递归按键合并（models 按键覆盖/新增、
  条目内字段级覆盖）、标量直接覆盖、list 整体替换；本地文件缺失=正常；
  合并结果沿用既有 fail-fast 结构校验。新增 `load_config_with_sources()`
  返回 `LoadedConfig`（base/local 路径 + 基底/本地 model refs 溯源，B4 的
  "仅可删本地覆盖渠道"判定依据）。
- `ModelConfig` 新增 `default_thinking`（`off|low|high|max`，缺省 `high`，
  非法值启动失败）与 `api_key_inline`（明文密钥，**只允许出现在
  config.local.toml**；`resolve_api_key` 内联优先于环境变量）；openai/
  anthropic 渠道的密钥来源放宽为 `api_key_env` 或 `api_key_inline` 二选一。
- `qap/core/local_store.py`：config.local.toml 读-改-写门面（无第三方 TOML
  写库，自研确定性序列化：含点号键自动加引号；重写整份文件会丢注释——
  已知权衡）。
- 修复根 `config.toml`：`glm-5.3`/`glm-5.3-flash` 的表键加引号（TOML 未引号
  化的点号键会被解析为 `glm-5`→`3-flash` 嵌套表，v1.1 契约渠道池无法加载）。
- 过渡：`PluginRegistry` 对**缺失/空**的 plugins_dir 不再抛"未实现"
  （仓库默认 `plugins_dir="plugins"` 使模块级 `create_app()` 启动即崩）；
  非空目录的发现加载在 B3 实现。
- 测试：`tests/test_config_overlay.py` 24 用例（覆盖优先级/深合并语义/
  default_thinking 枚举拒绝/内联密钥优先级/本地坏文件 fail-fast/
  LocalConfigStore 读写回环），全量 **247 passed**。

**B2（v1.1 思考程度与思考流）**：
- `CompletionRequest.thinking_level`（`off|low|high|max`）+ §9 映射：openai
  兼容渠道 → 请求体 `thinking:{"type":...}`（off→disabled，其余同名，GLM
  实测形状）；anthropic → off 不发 thinking 块，low/high/max →
  `{"type":"enabled","budget_tokens":2048/8192/16384}`，且启用思考时
  `max_tokens` 按预算加成（API 要求 max_tokens > budget）；mock 忽略但记录
  进 `request_log`（可观察）。
- 新 `ProviderEvent ThoughtDelta{text}`：openai 解析 `delta.reasoning_content`
  （GLM/DeepSeek 式思考增量），anthropic 解析 `thinking_delta`；Runtime 转发为
  SSE `message.reasoning`（载荷 `{conversation_id,message_id,delta,seq}`，
  总线注入 seq）并累加进新 `Message.reasoning` 字段（默认空串）；
  `message.completed` 载荷新增 `reasoning` 全文。
- `POST …/messages` 请求体扩展 `{"content","model_ref"?,"thinking_level"?}`：
  model_ref 须在渠道池（未知 → 422），thinking_level 非法 → 422（Literal）；
  取值优先级：消息级 > 渠道 default_thinking（Runtime 统一解析）。
- 测试：`tests/test_thinking.py` 19 用例（§9 映射表参数化/GLM 形状流
  增量拼接==全文与思考在前正文在后/anthropic 预算与 max_tokens/api 422 与
  优先级经 mock request_log 断言/SSE reasoning 帧序），全量 **266 passed**。

**B3（v1.1 编排 Agent 与插件安装）**：
- 内置 `orchestrator`（会话 `agent_id` 缺省即它，Create/PostMessage 均如此）：
  系统提示由注册表按**当前已注册专家**动态合成（安装/启停/卸载后自动
  刷新），说明平台能力+专家清单+平台工具，引导按任务自主 `dispatch_agent`。
- 平台工具 `dispatch_agent(agent_id, instruction)`（§8，声明对所有 Agent
  可见）：执行期守门——非 orchestrator 或嵌套深度 ≥1 → 结构化工具错误
  `dispatch_denied`（模型可自纠错）；子运行复用 Runtime 工具循环但不发
  SSE 增量，回复文本回流 orchestrator；子 Agent 的 emit_artifact/
  submit_task 经共享 ToolContext 归属当前会话与消息。
- 插件安装（§8 v1.1）：`plugin.json`（agent-plugins.org 1.0.0 基础字段）
  + 扩展键 `"qap":{"entry":"<module>:<factory>"}`；`plugin_loader` 按文件
  定位 importlib 加载（唯一化模块名，不污染 sys.path），任何失败 422 带原因
  /启动扫描记 broken，**不拖垮平台**。管理端点：
  `POST /api/v1/admin/plugins/install`（复制到 `agents.plugins_dir`，重名
  409）、`GET …/plugins`（builtin+installed+enabled+broken）、
  `PUT …/plugins/{id}`（启停持久化 config.local.toml
  `[agents.plugin_state]`）、`DELETE …/plugins/{id}`（卸载目录+状态；
  builtin 409）；启动扫描 plugins_dir 并按持久化状态恢复 disabled。
- 测试：`tests/test_dispatch.py` 8 用例 + `tests/test_plugins_admin.py`
  11 用例（安装全生命周期/坏插件 422 与 broken/深度限制/未知 agent 结构化
  错误/子运行故障不悬空），全量 **286 passed**。

**B4（v1.1 管理 API：渠道池）**：
- `GET /api/v1/admin/models` → `{"models": ModelChannel[]}`（含 `has_api_key`
  = 环境变量非空或本地文件内联；响应**无 api_key_inline 字段，绝不回传
  密钥明文**）；`PUT /api/v1/admin/models/{ref}` 更新或创建（provider/
  default_thinking 非法或非 mock 缺 base_url → 422；`api_key_inline` 只写
  config.local.toml，响应只体现 has_api_key）；`DELETE` 仅可删本地覆盖
  渠道（204），基底渠道（config.toml 定义）或仍被 agents.default_model_ref/
  builtin/已安装插件 model_ref 引用 → 409（悬空引用防护）。
- PUT/DELETE 即时生效：`AppState.providers` 与 `config.models` 原地增删改
  （Runtime 闭包共享同一 dict）；本地文件条目 None 值键不落盘（覆盖层
  "键缺失=继承基底"语义）。
- 测试：`tests/test_admin_models.py` 15 用例（GET 脱敏形状/has_api_key 随
  env 变化/内联密钥不回显且只落本地文件/非法输入 5 类 422/基底与被引用
  渠道 409/本地渠道删除后运行时 422），全量 **301 passed**。

**真实 GLM 冒烟驱动修正（2026-10-13）**：
- 契约修正（doc-first，ARCHITECTURE §3/§9 已同步）：glm-5.3 系
  `thinking.type` 只接受 `enabled`，思考强度走独立顶层参数
  `reasoning_effort ∈ low|high|max`（实测 disabled/low/high/max 作 type
  值一律服务端 1210）；openai 映射改为 off→`disabled`、low/high/max→
  `enabled`+`reasoning_effort` 同名。
- 修复两处 v1 潜伏缺陷（真实渠道首调即暴露，mock 从不触发）：① Runtime
  注入的平台工具是 dict 形态而真实 provider 只认对象属性（新增
  `base.tool_fields()` 归一化）；② provider 非预期异常会静默杀死 run
  task（两 provider 增加兜底折叠为 ProviderErrorEvent）。
- 真实冒烟（glm-5.3-flash + orchestrator）：模型自主 dispatch
  algorithm-designer → 4 artifacts + 3 步 VQE 任务 succeeded（QPU/CPU
  正确分配）+ 654 delta / 4 reasoning / 9 task.updated / 6
  hardware.updated。全量 **304 passed**。

**V1（v1.2/v1.3 硬件配置与 metrics，`feat/backend-v3`）**：
- `qap/core/config.py`：`[[hardware.nodes]]` per-node 可选规格键，与 kind
  严格绑定（错配/非法值启动 fail-fast）——`topology{rows,cols}` 仅 qpu
  （`2 ≤ rows*cols ≤ 1024`）、`vram_total_gb` 仅 gpu（>0）、
  `cpu_cores`+`memory_total_gb` 仅 cpu（成对、>0）、`status ∈
  {online,offline}`（缺省 online）；`TenantConfig` 增 `role ∈ {user,admin}`
  （缺省 user；入库 config.toml 的 role 键得以加载，守卫语义在 V3）。
- 新 `qap/hardware/metrics.py`：按 kind 生成 `HardwareNode.metrics` 初值
  ——QPU rows×cols 网格拓扑（qubit id=row*cols+col 与 (row,col) 一一对应；
  couplers=全部右/下相邻对；T1 20–80µs、T2 10–60µs 且构造性满足
  `t2 ≤ 2*t1`、readout 0.95–0.995、1Q 0.995–0.9999、2Q 0.98–0.995，
  **simulated** 数据非硬件观测）、CPU 规格+初始 usage/memory_used、GPU
  vram 总量+初始 used（used ≤ total 构造性成立）；随机源注入
  `random.Random`（种子可复现）；规格缺失 → metrics=None（前端降级）。
- `NodeRegistry(config, rng=)`：透传 config `status`（offline 节点自启动
  即被分配器/调度器跳过）与 metrics 初值；`set_metrics` 供模拟器漂移。
- `HardwareNode` 序列化增 `metrics`（dict|null，契约 §4 v1.2）。
- 测试：`tests/test_hardware_metrics.py` 25 用例（kind 键错配/拓扑规模界/
  非法 status 等 12 类 fail-fast；拓扑 id 双射与相邻对全集；模拟区间与
  t2≤2t1；种子复现；config offline 节点不被租约；snapshot 含 metrics），
  全量 **329 passed**。

**V2（v1.3 步骤实测 profile，`feat/backend-v3`）**：
- `Step` 增 `duration_ms`/`peak_memory_mb`/`subtask_id`（序列化缺省
  null；peak 赋值期校验 `>0 或 null`）；`StepSpec.workload` 执行参数
  （quantum `{"qubits":n}` 缺省 8 上界 16、classical `{"bytes":n}` 缺省
  256KB 上界 8MB、agent `{"agent_id","instruction"}`）——只进运行时，
  **不进序列化**（契约 §4 Step 字段纯净）。
- `orchestrator/runners.py` 重写为**真实计算负载**（measured，非编造、
  亦非硬件观测）：quantum=纯 Python 态矢量模拟（`2^n` 复幅度列表 + 逐层
  Hadamard/CNOT 迭代 + 范数守恒校验）、classical=JSON→zlib 压缩→解压→
  反序列化回环（记录数守恒）；tracemalloc 峰值在**纯同步块**内测量
  （asyncio 单线程下并发步互不污染；外部已开启 tracing 时退化为
  current 差；<0.05MB 在 1 位小数精度下不可表示 → null）。
- 调度器 `_execute`：`duration_ms` = perf_counter 墙钟差（1 位小数），
  覆盖执行全程——`started_at`/`finished_at` 升级毫秒精度 ISO（
  `core/clock.utcnow_iso_ms`；不变量 5 的 ±50ms 容差需要，前端 Date
  解析兼容）；超时失败步保留真实墙钟；retry 前清空上一轮实测。
- dispatch_agent 步：`scheduler.bind_agent_executor`（组装根注入
  `execute_agent_step`）——以目标专家的真实子运行执行（时长=子运行真实
  总时长、内存不可得 → null）；`orchestrator/step_context.py` ContextVar
  scope：执行期间子 Agent 经 submit_task 提交的任务自动挂 `subtask_id`
  （一次一层：`Task._submit_depth ≥ 1` 的 agent 步直接失败，嵌套不误挂；
  会话主运行提交的任务不挂接）。
- 测试：`tests/test_step_profile.py` 14 用例（序列化缺省/负值拒绝/
  workload 不序列化；quantum/classical 实测 profile 与 2^14 内存>0；
  ±50ms 时间戳一致性；未启动步 null；超时步保留墙钟；dispatch 步
  subtask 挂接/嵌套不误挂/会话级不挂接/未知 agent 失败），全量
  **343 passed**。

**V3（v1.2 租户角色与管理守卫，`feat/backend-v3`）**：
- `TenantConfig.role ∈ {user,admin}`（缺省 user，非法值启动拒绝，V1 已带
  最小配置支持）；`/tenants/me` 响应增 `role`；`TenantContext.role` 透传。
- `api/deps.require_admin`：全部 `/api/v1/admin/*` 端点（models CRUD +
  plugins 安装/启停/卸载）挂载——先鉴权（401/tenant_disabled 语义不变）
  再判角色，`role != admin` → 403 `{"error":{"code":"forbidden"}}`
  （新增 `ForbiddenError`，与租户禁用的 403 语义分开）；守卫先于端点
  自身校验（user 的畸形 payload 也是 403）。前端隐藏管理分区只是 UX，
  强制力在后端。
- 既有 admin 测试夹具的租户补 `role="admin"`（v1.2 契约演进：这些测试
  验证的就是管理功能本身）。
- 测试：`tests/test_admin_guard.py` 23 用例（role 缺省/非法/合法；/me 含
  role；7 端点 × user 403 参数化；守卫优先于 payload 校验；未知 key 401；
  禁用 admin → tenant_disabled；7 端点 × admin 过守卫；demo 403/admin
  200 CRUD 端到端），全量 **366 passed**。

**V4（v1.3 附件，`feat/backend-v3`）**：
- 新 `qap/domain/attachments.py`：kind 判定（`image/*`→image；`text/*` 或
  {.md,.txt,.py,.json,.toml,.csv,.yaml,.ts,.js}→text；其余 file）、
  上传校验（空文件/超 8MB→422）、`AttachmentStore`（内存字节存储，
  跨租户 404 语义；`get_for_conversation` 供发消息校验→422）。
- 新 `qap/api/routers/attachments.py`：`POST /conversations/{cid}/attachments`
  （multipart file → 201 `AttachmentMeta{id,name,mime,size,kind}`，id 前缀
  `att-`；非 multipart 由 FastAPI 表单解析 422）、`GET /attachments/{id}/raw`
  （原字节 + 存储 mime + 同租户隔离）。依赖新增 `python-multipart`。
- `Message.attachments: AttachmentMeta[]`（缺省 []）；`POST …/messages`
  增 `attachment_ids[]`（未知/跨会话/跨租户 → 422，元数据落 user 消息）。
- Provider 注入（§9 v1.3）：`AttachmentPart`（text 已截断 200k / image
  base64 / file 仅元数据）经 Runtime resolver 进入中间表示；
  openai 适配器——text 追加进正文（字符串 content 保持兼容），有图时
  content 升级 parts（`text` + `image_url` data URL）；anthropic——
  text/image 各成 content block（`source.type=base64`）；两适配器各
  **强制 200k 截断**；文本模型拒图的服务端错误经 ProviderErrorEvent →
  SSE `error` 透传（既有路径）；mock 仅记录摘要（`request_log[].attachments`）。
- 测试：`tests/test_attachments.py` 25 用例（上传 201 与 kind 判定 5 参数
  化/空与超限与非 multipart 422/未知会话 404/raw 回环与跨租户 404/
  attachments 缺省/attachment_ids 正常+未知+跨会话/openai text+image_url
  data URL/anthropic 双块/200k 截断/file 不注入/mock 仅记录/SSE error
  透传端到端），全量 **391 passed**。

**V5（v1.2 模拟器漂移与对外校验函数，`feat/backend-v3`）**：
- `hardware/metrics.drift_node_metrics`：QPU 保真度每 tick ±0.0002 均匀
  随机游走 → clamp (0,1]（4 位小数）；CPU `cpu_usage`（±0.04 clamp
  [0,1]）/`memory_used_gb`（±2GB clamp [0,total]）与 GPU `vram_used_gb`
  （±1GB clamp [0,total]）随机游走；T1/T2 静态规格；返回新 dict，
  构造性满足全部 v1.2 不变量。模拟器 `tick()` 同拍驱动利用率+metrics
  漂移，任一变化即发布 `hardware.updated`（含 metrics 全量节点）；
  `GET /hardware` 快照同源。
- 新 `qap/domain/invariants.py`（对外校验函数）：`validate_node_metrics`
  覆盖 §4 v1.2 全部不变量（fidelity ∈ (0,1]、t2 ≤ 2*t1 且 t1/t2>0、
  used ≤ total（内存/显存）、cpu_usage ∈ [0,1]、coupler 端点界内且网格
  相邻且不重复、qubit id 与 (row,col) 一一对应、qubits_count ==
  rows*cols == len(qubits)）；`validate_step_profiles` 覆盖不变量 5
  （duration ≥ 0、peak > 0 或 null、finished 步起止时间戳齐备且
  |duration−span| ≤ 50ms；级联取消步豁免）。违例抛 ValidationFailed
  并指明字段。
- 测试：`tests/test_hardware_drift.py` 25 用例（漂移 ≤0.0002、T1/T2 静止、
  25 拍不变量保持、边界 clamp、tick 事件含 metrics、校验函数 12 类负
  样本 + 不变量 5 正/负样本；test_step_profile 增真实任务整包复核），
  全量 **416 passed**。

**v4 后端（2026-10-14 起，`feat/backend-v4`，契约 v1.4：logicalcloud 真机
接入、专家真实化、dispatch 实时外显）**：五片 TDD 提交——

**V1（logicalcloud 适配层）**：`hardware/lqcloud_adapter.py`——契约 §6
线路 JSON → `lqcloud.QuantumCircuit` 转换器（门 H/X/Y/Z/RX/RY/RZ(theta)/
CX/CZ，CNOT 为 CX 别名；**首个 MEASURE 前自动插入 barrier**——平台实测
硬约束，无 barrier 提交即 CircuitError；未知门/畸形 → ValueError）；
`LqCloudAdapter` 薄封装（构造注入 provider：生产 `LQCloudProvider`、测试
FakeCloudProvider 零网络）：`list_backends`（规范 dict）/`submit`（固定
`readout_correction=True`）/`poll`（{status, queue_position}）/
`result_counts`（cloud-observed 真实计数）；服务端异常原样上抛。
依赖为可选 extra：`pip install -e ".[hardware]"`（lqcloud==0.5.1）。
测试：`tests/test_lqcloud_adapter.py`（12 用例）+ 共享替身
`tests/fake_cloud.py`（现网同构 5 台真机、脚本化轮询、故障注入）。

**V2（硬件注册表 provider 模式）**：`[hardware]` 新增键 `provider`
（`simulated` 缺省 | `logicalcloud`，枚举外 fail-fast）、`lqcloud_base_url`
（缺省 https://cloud.logicalqubit.com）、`lqcloud_api_key_env`（缺省
LQCLOUD_API_KEY，空白串拒绝；simulated 模式空节点表拒绝、logicalcloud
允许为空）。`build_node_registry()`（registry.py）——logicalcloud 模式启动时
经适配器实拉真机 → `HardwareNode`（id=`lq-<name>`、model=chip_architecture、
active→online/其余→offline、capacity=1；metrics.topology 用云端
qubit_coordinates 摆放比特点：rows/cols=坐标极值+1、qubit id=列表下标含
x/y、**couplers 空 + fidelity 全 null——平台未提供，诚实为空**，
`source: "cloud-observed"` 标注）；手写 qpu 节点被忽略、gpu/cpu 保留；
**密钥环境变量缺失/lqcloud 未安装/云端拉取失败/空列表 → 启动
ConfigError fail-fast 带原因**（真实模式禁止静默回退伪造数据）。模拟器
`tick()` 只作用于 `simulated_ids()`（手写节点）——lq-* 节点利用率恒 0
不漂移（云端未提供，诚实降级）。`invariants.validate_node_metrics` 增
cloud-observed 分支（qubits_count==len(qubits) 不要求满网格；fidelity
非 null 或 couplers 非空 → 违例——反伪造）。`build_app_state`/`create_app`
增 `cloud_adapter=` 注入点（测试传 FakeCloudProvider，None=生产真连）。
测试：`tests/test_hardware_provider.py`（16 用例）。

**V3（quantum 步真实执行）**：`Step` 增 `circuit`/`cloud_job_id`/
`queue_position`（序列化字段，缺省 null；circuit 载荷构造期按 §6 校验，
畸形拒绝）。`StepSpec`（submit_task steps[]）扩展可选 `circuit`/`shots`
（缺省 1024）/`node_id`（缺省自动选首个 online QPU；接受 lq-<name> 或裸
后端名）；circuit 落 `Step.circuit`（序列化）、shots/node_id 落 workload
（运行时）。新 `orchestrator/cloud_runner.py` `CloudStepRunner`：仅当
quantum 步携带 circuit 且注入适配器时走真机——选节点（指定→租约节点→
首个 online lq-*；指定节点离线/未知 → 诚实报错）→ `adapter.submit`（记
`cloud_job_id`）→ 轮询（`queue_position` 变化经 EventBus 推 `task.updated`、
`step.detail` 记"云端排队 #n"）→ `result_counts` → **自动 emit counts
artifact**（标题注明后端名与 job_id、cloud-observed；计数守恒按云端实际
返回合计——读出修正 round 残差诚实计入）+ detail 记实测等待/执行时长
（duration_ms 为调度器 perf_counter 实测保持；peak_memory 云路径恒 null）；
失败（CircuitError/终态 failed）→ step.error 含服务端错误，不产 artifact；
阻塞 requests 调用一律 `asyncio.to_thread`。simulated 模式/无 circuit 步
完全委托既有 `simulate_step`（v1.3 真实计算负载，行为不变）。配套：
`step_context.running_task_scope`（调度器 `_execute` 挂所属 Task，runner
经 ContextVar 取回推 task.updated，协议签名不变）；`Task._message_id`
私有锚点（submit_task 记录 ToolContext.message_id）；组装根
`emit_step_artifact`（Artifact 构造校验 → 立即推 `artifact.created`
【载荷含消息锚点】→ 回写锚点消息 artifacts 列表）；`AppState.tools`
显式暴露。测试：`tests/test_cloud_steps.py`（15 用例，含组装根全链：
artifact.created 即时事件 + 消息产物回写）。

**V4（专家真实化 + mock 诚实化）**：内置专家 system_prompt 全部重写为
**通用领域提示**（去模板化）——algorithm-designer：问题分析→量子适用性
判断→建模（MIP/QUBO/化学映射等，经典-量子混合为常态）→**选择算法**
（QAOA/VQE/Grover/相位估计/绝热演化/经典求解器兜底，不预设 VQE）→合成
线路（emit_artifact(circuit) + submit_task 携带 circuit/shots/node_id，
logicalcloud 模式真机执行）→解读真实结果（cloud-observed 标注、勿虚构）；
calibration：校准数据→误差分析→波形修正计算（DRAG/脉冲整形，公式与参数
依据）→emit_artifact(waveform)+调参建议；orchestrator 提示增**诚实性
要求**（专家会真实执行真机任务，只引用真实回复与产物，勿编造结果）。
**mock 诚实化**：剧本未覆盖的 agent → 单条 `[mock 渠道] 演示脚本未覆盖
该请求——请在输入区选择真实渠道（如 glm-5.3-flash）`，不再产出看似真实
推理的模板；命中剧本的演示链路（orchestrator/algorithm-designer/
calibration）保持不变。测试：`tests/test_expert_prompts.py`（9 用例：
通用提示正/负断言 + 诚实通知 + 演示链路保持）。

**V5（dispatch 实时外显 + artifact 即时事件）**：Runtime 在 dispatch_agent
子运行全程把子 Agent 的 ProviderEvent 映射为 SSE `agent.activity`
（§7 v1.4 载荷：conversation_id/message_id/agent_id/phase/delta?/tool?/
seq——seq 由总线注入并加入 SEQ_CARRYING 集合；phase ∈ dispatch_started |
reasoning_delta | text_delta | tool_call | dispatch_completed；正文增量不进
message.delta，与主运行流不混淆；成败均发 dispatch_completed 收束）。
`emit_artifact` **产生即推** `artifact.created`（PlatformTools 注入
EventBus——组装根生产路径已接；载荷含消息锚点与产物信封，前端流式插卡），
`message.completed` 仍全量携带（既有事件不变；测试注入位 events=None 时
行为与 v1.3 完全一致）。全局流仍只转发 task/hardware 事件（§7 语义保持）。
测试：`tests/test_dispatch_stream.py`（6 用例：事件序与 seq 单调、tool_call
载荷、主运行流不受影响、emit 即时可订阅、created 先于 completed 且
completed 仍全量、子运行产物流式外显 + 全局流隔离）。全量 **476 passed**
（418 基线 + v4 轮新增 58）。

**冒烟修正（两片，真实联调发现）**：① 云端拓扑真实形状——`qubit_coordinates`
实为 **dict**（键=比特下标）、rows/cols 云端显式、`coupling_map` 连接对
照录（tq_fidelity 诚实 null，绝不伪造保真度）；`invariants` cloud 分支
同步（连接对照录、保真度数值=伪造即拒绝）。② 门名大小写归一——GLM 实测
产出小写 "h"/"cx"，转换器 strip+upper 归一（未知门仍 ValueError）+
专家提示明确大写门名规范。全量 **480 passed**。

**v4 后端手动冒烟记录（2026-10-14，结果不入测试）**：
`config.local.toml`（gitignored）覆盖 `provider="logicalcloud"` +
`agents.*.model_ref="glm-5.3-flash"`，`set -a; source secrets/{lqcloud,
glm}.env; set +a`（lqcloud.env 键名 APIkey → `export LQCLOUD_API_KEY=$APIkey`）
后起服务：
- `GET /hardware`：5 台 lq-* 真机（MQ02/AGate-100/QZ01-surface_code/
  QZ01-repetition_code online、QZ02 offline；model=云端 chip_architecture
  实测值 AGate 100/165/30；MQ02 24 比特 8x8 网格 23 耦合器、AGate-100
  101 比特 14x14 157 耦合器；保真度全 null=cloud-observed 诚实降级）；
  gpu/cpu 模拟节点保留；lq-* 利用率恒 0 不漂移。
- GLM 渠道（Coding Plan 端点）发"给我一个 2 比特 Bell 线路，在真机上跑
  256 shots 并解读结果"：SSE 流实时观察 dispatch_started → 1245 条
  agent.activity（reasoning/text/tool_call 增量）→ dispatch_completed；
  专家即时流式 2 个 circuit artifact（artifact.created）→ submit_task
  （quantum 步带 circuit/shots）→ 调度租约 lq-MQ02 → 云端 job
  task_61631313e17749e6（task.updated 推送 queue_position=1 排队帧）→
  5.2s 后完成，**counts artifact「MQ02 实测计数（job
  task_61631313e17749e6，cloud-observed）」自动发射：00=131/11=123/10=2/
  01=0（真实 Bell 态读出，计数守恒 256）**；step.duration_ms=5263.2
  （perf_counter 实测）；orchestrator 最终回复含诚实声明（计数未回传前
  不编造数值）与解读框架。首次冒烟曾因 GLM 小写门名失败（step.error
  诚实透传"unsupported gate 'h'"）——修正后复跑通过。

## 前端 (Frontend)

*本节由 `feat/frontend` 分支的开发切片维护更新：组件清单、页面说明、测试结果。*

技术栈：React 18 + TypeScript(strict) + Vite + zustand + vitest；**无 UI 组件库、
无 Tailwind、无图表库、无 webfont**（依赖白名单见 docs/DEVELOPMENT.md 与
frontend/package.json；v1.5 增补 react-markdown/remark-gfm/remark-math/
rehype-katex/katex——用户明确要求的 Markdown/公式渲染管线）。

**v5 前端（2026-10-14，feat/frontend-v5，契约 v1.5）**：渲染缺陷修复轮，
四片 TDD 提交。① **W1 Markdown+公式+表格管线**（用户反馈"星号井号原样输出/
公式表格不渲染"）：新增 `components/chat/MarkdownContent.tsx`——react-markdown +
remark-gfm + remark-math + rehype-katex（行内 `$…$`、块级 `$$…$$`；独立成段的
单行 `$$…$$` 归一为围栏形式保证 katex-display）；样式全 token（标题 --fs-*、
代码块 mono+--bg-inset+圆角、表格边框 --border-default/表头 --bg-inset/行 hover
--bg-elevated/横向滚动容器、引用 --border-strong、链接 --accent-cyan、KaTeX 配色
CSS 变量适配三主题）；默认禁 raw HTML；内部 ErrorBoundary 兜底流式截断 Markdown
不崩溃（content 变化自动重试）；MessageBubble 助手正文与用户气泡、ChatPanel 流式
正文均走该管线（pre-wrap 撤销）。构建分包 katex/markdown 独立 chunk（缓存友好）。
② **W2 电路符号 v1.5**（用户反馈"测量后又画 CNOT/RZZ 没显示/CZ 不像两点/旋转门
无角度"）：`CircuitOperation` 增 `params?: number[]`（畸形滤除，空→undefined）；
**CZ = 竖线 + 两端实心圆点**（复用控制点样式，无 ⊕ 无方块，缺 controls 的宽容
形态同样两点）；**RZZ(θ) = 竖线 + 两端实心点 + 线中点等宽标签**（θ=params[0]
两位小数）；RX/RY/RZ 门标签带角度 `RX(0.11)`（缺失/NaN/负值退化为门名——负角度
按畸形降级是渲染层约定）；tooltip 含角度；门名大小写归一（后端真机小写 h/cx）；
**测量后防御**：utils/circuit 布局把"某比特 MEASURE 之后仍作用该比特"的操作剔除
并计入 dropped/droppedAfterMeasure，画布追加独立提示（后端校验第一道闸、渲染层
兜底）；CircuitCanvas 四条提示文案迁入 i18n 字典（circuit.note.*，三语同步）。
③ **W3 Mock 演示升级**：fixtures c-1 助手回复改为完整 Markdown 样例（二级标题/
加粗 H₂ STO-3G/无序列表/三行参数表/行内期望值公式 $E(\theta)$ 与块级基态能量
公式 $E_0\approx-1.1373\,\mathrm{Ha}$）；c-1 circuit 载荷改 v1.5 形态（RY/RZ 带
params 0.11/0.23 + CZ + RZZ(0.31) + MEASURE 收尾，测量后无操作不触发兜底提示）；
c-2 校准回复带行内公式；vqeScript/calibrationScript 剧本同步（流式增量直接驱动
Markdown 管线）——`VITE_USE_MOCK=1` 演示直接可见公式/表格/新符号三类渲染效果。
④ **W4 测试与 i18n 收尾**：ChatPanel 增流式 Markdown 集成测试（加粗/公式渲染 +
半截表格不崩）；i18n 三语互异清单纳入 circuit.note.*（key 集合一致性既有测试锁定）；
`VITE_USE_MOCK=1 npm run dev` 冒烟（200/无变换错误）。**全量 250 passed**
（基线 223 + v5 新增 27：MarkdownContent 10 / MessageBubble 2 / utils·circuit 6 /
CircuitCanvas 6 / fixtures 2 / ChatPanel 1），`npm run build` 零错误（katex/markdown
独立 chunk：主包 267KB + markdown 440KB）。

**v4 前端（2026-10-14，feat/frontend-v4，契约 v1.4，进行中）**：四片 TDD 提交。
① **类型与事件归并（W1）**：`Step` 增 `circuit/cloud_job_id/queue_position`；
SSE 新事件归并——`agent.activity` 按 message_id→agentId 聚合进
`subagentActivityByMessage`（reasoning/text delta 拼接、tool_call 计数、
dispatch_completed 收束），`artifact.created` 即时插卡（未 completed → 流式
临时 artifacts 骨架；completed 事件全量覆盖去重）；seq 单调门控（乱序/重复
丢弃）。
② **专家工作区（W2，用户核心反馈"dispatch 过程不可见"）**：助手消息内嵌
「🔧 专家 <id> 工作区」渐进块——运行中展开（专家名+呼吸徽标+流式正文+
「→ 调用工具」行），完成自动折叠为「专家已完成 · 输出 N 字 · 工具 M 次」
摘要行，可展开回看；流式气泡与已完成气泡均渲染。
③ **artifact 流式插卡 + 演示/排队徽标（W3）**：artifact.created 即时插卡
（半透明骨架态 → completed 转正常）；composer 所选 mock 渠道显示「演示」
warning 徽标（title 防误用提示）；DagView 节点 queue_position 非空显示
「排队 #n」warning 呼吸徽标，Step Drawer 补 cloud_job_id/circuit 摘要。
④ **硬件真机展示与 mock 全链（W4）**：QPU 卡副行来源标注（lq-* 真机/
无保真度 →「云端 · N 比特 · <model>」，simulated →「模拟 · N 比特」；
云端利用率无数据显示 "—"）；QpuTopologyCanvas 云端降级——仅比特坐标点
（qubit_coordinates 摆放）、coupler/readout/图例隐藏、tooltip「平台未提供」；
mock fixtures 增 5 台 lq-* 真机（4 在线/1 离线，镜像 get_backends() 实拉）
+ 专家工作区剧本 + artifact.created 流 + quantum 步 queue_position 3→2→1
演进与 cloud_job_id/circuit；全部新文案三语同步。**测试 223 passed**
（基线 188 + v4 新增 35），build 零错误。

**v3 前端（2026-10-13，feat/frontend-v3，契约 v1.2/v1.3）**：六片 TDD 提交——
① **类型与硬件纯函数 + 自动建会话（W1）**：`HardwareNode.metrics` 三形状可选
（QPU 拓扑/CPU/GPU）、`AttachmentMeta`、`Step` 增 `duration_ms/peak_memory_mb/
subtask_id`、`TenantInfo.role`；`utils/hw.ts` 色阶与格式化（fidelityLevel 阈值表
2Q 0.992/0.985、1Q 0.999/0.995、readout 0.98/0.95；usageLevel 0.8/0.9；
medianTqFidelity；formatFidelity/Us/GB）+ `formatBytes/formatDuration`；
`sendMessage` 无活跃会话自动建会话（标题=前 20 字）、404 自动重建重试一次、
失败 `sendError`+`failedDraft` 内联重试、`sending` 防重入。

② **composer 工具条与附件（W2，§5/§5.2）**：模型/思考选择器从顶栏迁入
输入区底部工具条（左 ＋附件 · 中 模型▾ 思考▾ · 右 发送）；顶栏改为常驻
外观控件（主题三档分段图标 + 语言下拉）+ 租户徽标含角色（admin「管理员」）
+ 连接灯；附件全流程（file input → 无会话自动建会话 → POST attachments →
预览条缩略图/文件卡 → × 移除 → attachment_ids 随消息发送；用户气泡内嵌
附件条复用 AttachmentStrip）；发送中态 + 失败内联重试。
③ **DagView v1.3 时间分析与嵌套下钻（W3，§6.3）**：节点实测标注
`时长 413ms`/`内存 18.3MB`（measured，等宽，null→"—"；节点 232×92——
v1.3 增实测行）；「结构/时间线」二段切换——时间线=水平 Gantt（x=任务起点
相对时间、宽=duration_ms、kind 色、运行中实时增长、0–100% 五档刻度、悬停
起止+时长）；⊕ 角标下钻子 DAG（getTask 递归 + 面包屑，子图两模式）；
Drawer 补实测时长/峰值内存/子任务链接。
④ **硬件面板 v1.2 与 10 QPU 机群（W4，§6.4）**：QPU 分组头
`QPU · 在线 6/10`；离线卡降饱和+斜纹+离线徽标；QPU 卡副行
`20Q · 2Q 保真度中位 NN.NN%`；CPU 卡 CPU%+内存双迷你条、GPU 卡 VRAM 迷你条
（usageLevel 0.8/0.9 告警着色）；QpuTopologyCanvas 手写 SVG 拓扑保真度图
（qubit 圈内 id+圈下 readout%、coupler 线中 tq%、三档色阶、悬停 T1/T2/1Q/
readout tooltip、图例置底、>12×12 滚动）挂 QPU Drawer；mock fixtures 10 QPU
（确定性 LCG 生成，满足 §4 全部不变量与模拟区间）+ admin 租户 +
`localStorage['qap.mockRole']='user'` 双角色切换 + 步骤实测字段/子任务。
⑤ **设置页权限/插件状态/文字边界（W5，§5 v1.2/v1.3）**：role=user 隐藏
渠道/插件分区（强制力在后端 403）；admin 可见且分区标题带「管理员」徽标
（mock 双角色：`localStorage['qap.mockRole']='user'` 刷新切换）；插件卡
**状态徽标三态**（启用中 success / 已停用 faint / 加载失败 danger+broken
原因）+ capabilities 标签 + model_ref + 描述；文字边界修复（容器
min-width:0、描述 word-break、渠道表 overflow-x 滚动容器）。
⑥ **i18n 收尾（W6）**：v3 全部新文案（composer/附件/时间线/下钻/实测/
硬件拓扑/插件状态/权限）三语同步，key 集合一致性 + 三语互异 + 带参插值
测试锁定；`npm test` 190 passed（基线 137 + 新增 53），build 零错误。
**集成修订（2026-10-13，main）**：与真实后端联调对齐四处契约——① SSE 流 URL
携带 `?api_key=`（`buildStreamUrl`/新增 `buildGlobalStreamUrl`）；②
`TenantInfo` 字段对齐后端 `usage_snapshot`（`active_tasks`/`enabled`）；③
`sendMessage` 乐观用户消息改用本地临时 id（202 的 `message_id` 是后端预创建
assistant id，误用会在 completed 去重时吞掉 artifacts），mock 引擎同步对齐该
语义；④ ApiError 解析后端 `{"error":{code,message}}` 业务消息。测试
**84 passed**（新增 4），build 零错误。

**视觉走查修订（2026-10-13，main，真实浏览器截图评审）**：① 任务 DAG 改
**纵向流水线布局**（横向布局在 360px 检查器溢出 744px 且画布高度塌缩为
19px——节点被裁成不可见；修复后画布显式内容尺寸 + 层自上而下堆叠）；
② 消息增加 HH:MM 等宽时间戳（formatHM）；③ 对比度修订：占位文案/会话副行/
DAG 节点 meta/趋势线由 faint 升 secondary；④ `color-scheme: dark` 修正原生
select 弹出层；⑤ Artifact 箭头展开旋转 90° affordance；⑥ 量子线路导线在
MEASURE 表针后收束；⑦ 容量点增加 title 提示；⑧ DAG 依赖边提亮。测试
**91 passed**（新增 formatHM×6 + DAG 纵向几何×1），build 零错误；
DAG 面板/时间戳/占用徽标（"algorithm-designer · t-3/s-8"）截图复验通过。

**v1.1（2026-10-13，main）**：三主题（浅/深/护眼）、三语言（中/EN/JA）、顶栏
模型+思考程度选择器（移除 Agent 选择）、设置页四分区（外观/模型与思考/提供商
渠道/插件管理）、思考过程折叠块、DAG 232×76 与侧栏截断修复、Mock 全链路含
orchestrator 与 waveform。npm test 137 passed；连接灯/插件徽标/护眼对比度
经真实浏览器走查修复。

**v1.3（2026-10-14，main）**：composer 工具条（＋附件/模型/思考/发送）、
附件预览与消息附件卡、发送自动建会话（404 自愈）、DAG 时间线 Gantt 与
实测时长/内存标注、⊕ 子 DAG 下钻、QPU 拓扑保真度图（三档色阶+tooltip+
图例）、QPU 在线 6/10 与离线标注、CPU/内存/VRAM 监控条、设置页角色分流
（user 隐藏管理分区）、插件状态徽标、同源代理（Vite /api 代理规避跨域
webview 问题）。npm test 188 passed。

**v2 前端修订（2026-10-13，feat/frontend-v2，契约 v1.1）**：六个切片——
① **三主题**（§2.1）：`tokens.ts buildTokenCss()` 输出 `:root`(dark 默认) +
`[data-theme="light"|"sepia"]` 覆盖块（色板逐字对齐文档表；浅/护眼阴影降档
`--shadow-1/2`、`color-scheme:light`）；`ThemeProvider` 挂 `<html data-theme>`，
设置页三选一卡片即时预览，localStorage 持久化。② **三语言**（§2.2）：自研
`src/i18n/`（zh/en/ja 字典 + `t(key,params?)`，零重依赖），界面 chrome 全量
迁移（顶栏/侧栏/检查器 Tab/设置页/空态/按钮/占位/状态徽标/主题名/思考程度名/
相对时间），三字典 key 集合一致性由测试锁定；用户与 Agent 内容不翻译。
③ **顶栏改造**：移除 Agent 选择器（顶栏+输入区两处，编排 Agent 自动调度），
新增模型选择器（admin models 渠道池）+ 思考程度选择器（off/low/high/max；
切模型默认跟随渠道 default_thinking，手动改过本会话保持）；选择随消息发送
（POST body `model_ref`/`thinking_level`）。④ **设置页**（§5 四分区）：侧栏
底部齿轮入口，覆盖侧栏+对话区（检查器保留）——外观（主题/语言）、模型与思考
（本地偏好持久化）、提供商渠道（GET/PUT/DELETE admin/models；api_key 仅写入
永不回显；错误内联）、插件管理（启停开关/安装 source_path/两段式卸载确认）。
⑤ **思考过程展示**（§7 v1.1）：store 归并 `message.reasoning` SSE（独立缓冲、
seq 单调、先于正文）；completed 并入 `Message.reasoning`；助手消息顶部
"🧠 思考过程"折叠块（默认收起+字数摘要+chevron 旋转；展开 mono/caption/
secondary/240px 滚动；流式期间"思考中…"微光标态）。⑥ **截断修复（§5.1）+
Mock 全链路**：DAG 节点 232×76、名称 2 行 line-clamp、id 单行截断、任务标题
min-width:0；侧栏会话条目 min-width:0；Mock 引擎补齐 admin models fixtures
（glm-5.3/glm-5.3-flash/mock + default_thinking）、插件 fixtures（含 broken
示例）、orchestrator 编排流（文本启发式 dispatch 专家 → circuit+counts /
waveform）、reasoning 流（思考增量→正文）；`VITE_USE_MOCK=1` 下设置页/模型
选择/思考展示全部可演示。测试 **137 passed**（v1 91 + 新增 46），build 零错误。

### 组件清单（随切片增长）

- `src/styles/tokens.ts` —— 设计系统唯一来源：全部色板/字体栈/字号/间距/圆角/
  阴影/z-index/动效/布局尺寸，编译为 `:root` CSS 变量注入（逐字对齐
  docs/design.md §2–§5、§7）。
- `src/styles/global.css` —— reset、五态按钮/输入、focus-visible ring、滚动条、
  流式光标闪烁(530ms)、呼吸光晕(2s)、条形生长(160ms)、
  `prefers-reduced-motion` 全量降级；`src/styles/states.css` —— 卡片/Tab、
  状态徽标、警示条、同构骨架屏（shimmer 1.2s）、全局错误条。
- `src/components/layout/` —— `AppShell`（三栏 Grid：264px 会话侧栏 · 流体对话区
  max 820px · 360px 检查器）、`TopBar`（56px：产品名 / Agent 选择器 / 租户徽标 /
  SSE 连接灯）、`SessionSidebar`（会话列表/新建/切换）、`InspectorPanel`
  （硬件拓扑｜任务 DAG Tab）、`ConnectionLight`（绿/黄/红）。
- `src/types/` —— 领域模型与 SSE 事件契约（逐字段对齐 docs/ARCHITECTURE.md §4/§7）。
- `src/api/client.ts` —— REST（Bearer/JSON/ApiError 含 Retry-After）+ EventSource
  流封装（断线指数退避 1s→30s 封顶，会话流 `?after=<seq>` 续传）。
- `src/api/mock/` —— Mock 引擎：fixtures 驱动全部面板；sendMessage 触发脚本
  演示链路（流式 delta → circuit+counts artifacts → 三步 DAG 推进 →
  hardware allocation 变化，对齐 ARCHITECTURE §10）；2s 利用率随机游走 tick。
- `src/store/` —— `uiStore`（布局折叠状态）+ `appStore`（bootstrap / 会话切换 /
  消息发送 / SSE 事件归并：流式累积、task upsert、硬件节点与 60s 利用率历史）。
- `src/components/chat/` —— 对话区：`ChatPanel`（消息流分组/自动跟随滚动/空态/
  错误警示条）、`MessageBubble`（用户右对齐气泡、助手左对齐头像分组+分隔线）、
  `MessageInput`（Enter 发送 / Shift+Enter 换行 / Agent 快捷切换）、
  `StreamingCursor`（530ms 闪烁光标）、`ArtifactCard`（类型徽标+展开收起，
  未知/畸形 type 降级为原始 JSON 视图，永不崩溃）。
- `src/components/viz/` —— 可视化渲染器（全部手写 SVG，禁图表库）：
  `CircuitCanvas`（qubit 横线等距编号、格点门 44×36、CNOT 控制点+⊕、MEASURE
  表针、悬停 tooltip、列压缩无空列、>32 qubits 截断）、`CountsHistogram`
  （归一化不变量 max 条高==绘图高、160ms 条形生长、hover 计数/占比、降序排列、
  空/畸形降级）、`WaveformCanvas`（I/Q 多通道折线 + 图例）、
  `DagView`（kind 色节点 + 统一状态徽标 + 贝塞尔依赖箭头 + 运行呼吸光晕 +
  点击节点 Drawer 详情 + 环/未知依赖降级）、`HardwareTopology`（kind 分组卡片
  网格、型号/容量点/利用率迷你条与 60s sparkline、allocation 徽标
  "agent · task/step"、offline 降饱和斜纹、点击开 Drawer 全量信息+历史任务）。
- `src/components/common/` —— `StatusBadge`（五状态统一徽标：pending 空心/
  running warning 呼吸/succeeded/failed/cancelled faint）、`Drawer`
  （右滑详情抽屉，Esc/遮罩关闭，z-drawer）。、`ThemeProvider`（§2.1 三主题挂载：
  订阅 uiStore.theme 写 `<html data-theme>`）。
- `src/i18n/` —— 轻量自研三语 i18n（§2.2）：`zh.ts`/`en.ts`/`ja.ts` 字典 +
  `translate()`/`t()`/`useTranslate()`（语言存 uiStore + localStorage，
  切换即时生效；三字典 key 集合一致性由 i18n.test 锁定）。
- `src/components/chat/ReasoningBlock.tsx` —— 思考过程折叠块（v1.1 §5）：
  默认收起 + 字数摘要 + chevron 旋转；展开 mono/caption/secondary/240px 滚动；
  流式 active 态"思考中…" + 微光标。
- `src/components/settings/` —— 设置页（v1.1 §5 四分区）：`SettingsPage`
  （覆盖侧栏+对话区，检查器保留）+ `AppearanceSection`（主题三选一卡片即时
  预览 + 语言三选）+ `ModelThinkingSection`（默认模型/思考，本地偏好）+
  `ChannelsSection`（渠道表 + 新建/编辑表单：api_key 仅写入不回显、校验内联、
  两段式删除）+ `PluginsSection`（启停开关/安装/两段式卸载）。
- `src/api/mock/scripts.ts` —— Mock 编排脚本（v1.1）：思考增量（thinking=off
  跳过）→ 文本启发式 dispatch 专家（VQE/校准/回显）→ artifacts + DAG 推进。
- 响应式：<1280px 检查器浮层化；<960px 侧栏抽屉化（`src/styles/layout.css`）。

### 运行

```bash
cd frontend && npm install
npm run build          # tsc -b && vite build
npm test               # vitest run
npm run dev            # 开发服务器（5173），连接 http://127.0.0.1:8000
VITE_USE_MOCK=1 npm run dev   # Mock 模式：后端未启动也可完整演示
```

### 测试结果（feat/frontend-v2 · 最终）

`npm test`：24 个文件 **137 个用例全绿**（v1 的 91 条保持 + v2 新增 46 条：
三主题 token 断言 5、i18n 字典/切换 6、ThemeProvider 4、TopBar 模型/思考
联动与请求体 4、ReasoningBlock 折叠与 SSE 归并 6、admin 渠道/插件契约与编排流
11、设置页四分区 9、DAG 232×76 几何更新 1 等）。`npm run build`：零 TS 错误
（JS 238 kB / gzip 74 kB）。

### 非理想态与动效（S6）

- loading：同构骨架屏（会话项/消息流/硬件卡片/DAG 节点，shimmer 1.2s），
  bootstrap 完成前各面板呈现；
- empty：无会话/无消息/无任务/无硬件四类插画式空态 + 行动按钮；
- error：bootstrap 失败 → 顶栏下全局警示条 + 重试；SSE error → 消息区内联
  警示条（流自动指数退避重连，无需手动重试）；
- 动效全部 ≤200ms（折叠/淡入/条形生长 160ms），循环类（光标 530ms/骨架
  1.2s/呼吸 2s）在 `prefers-reduced-motion` 下全部停用并降级为实线描边；
- 光标完成淡出（120ms 过渡，220ms 后卸载）。

（全部切片完成：S1 骨架 / S2 数据 / S3 对话 / S4 可视化 / S5 检查器 / S6 打磨。）

## References

- pi / pi-agent-core（本平台 Agent 运行时"统一 LLM API"设计所参照的极简开源实现，MIT）:
  https://github.com/earendil-works/pi 、 https://pi.dev
- OpenAI Chat Completions API（streaming）: https://platform.openai.com/docs/api-reference/chat
- Anthropic Messages API（streaming）: https://docs.anthropic.com/en/api/messages-streaming
- FastAPI 官方文档: https://fastapi.tiangolo.com/
- Server-Sent Events 规范（MDN）: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- agent-plugins.org 插件清单 schema（兄弟项目 pulseagent 的 plugin.json 所遵循）:
  https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
- Q-CTRL Boulder Opal（前端信息密度与可视化布局的工程参照，非代码来源）:
  https://q-ctrl.com/boulder-opal
