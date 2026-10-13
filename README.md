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

## 前端 (Frontend)

*本节由 `feat/frontend` 分支的开发切片维护更新：组件清单、页面说明、测试结果。*

技术栈：React 18 + TypeScript(strict) + Vite + zustand + vitest；**无 UI 组件库、
无 Tailwind、无图表库、无 webfont**（依赖白名单见 docs/DEVELOPMENT.md 与
frontend/package.json）。

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
  （右滑详情抽屉，Esc/遮罩关闭，z-drawer）。
- 响应式：<1280px 检查器浮层化；<960px 侧栏抽屉化（`src/styles/layout.css`）。

### 运行

```bash
cd frontend && npm install
npm run build          # tsc -b && vite build
npm test               # vitest run
npm run dev            # 开发服务器（5173），连接 http://127.0.0.1:8000
VITE_USE_MOCK=1 npm run dev   # Mock 模式：后端未启动也可完整演示
```

### 测试结果（S6 后 · 最终）

`npm test`：17 个文件 80 个用例全绿。`npm run build`：零 TS 错误（JS 194 kB /
gzip 62 kB）。

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
