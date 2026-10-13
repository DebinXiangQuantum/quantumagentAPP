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

## 前端 (Frontend)

*本节由 `feat/frontend` 分支的开发切片维护更新：组件清单、页面说明、测试结果。*

技术栈：React 18 + TypeScript(strict) + Vite + zustand + vitest；**无 UI 组件库、
无 Tailwind、无图表库、无 webfont**（依赖白名单见 docs/DEVELOPMENT.md 与
frontend/package.json）。

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
