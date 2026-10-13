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

（基线：尚未实现——见 `docs/ARCHITECTURE.md` 的目标设计。）

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
  骨架 shimmer、流式光标闪烁(530ms)、呼吸光晕(2s)、条形生长(160ms)、
  `prefers-reduced-motion` 全量降级。
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
- 响应式：<1280px 检查器浮层化；<960px 侧栏抽屉化（`src/styles/layout.css`）。

### 运行

```bash
cd frontend && npm install
npm run build          # tsc -b && vite build
npm test               # vitest run
npm run dev            # 开发服务器（5173），连接 http://127.0.0.1:8000
VITE_USE_MOCK=1 npm run dev   # Mock 模式：后端未启动也可完整演示
```

### 测试结果（S3 后）

`npm test`：8 个文件 42 个用例全绿（+13：Artifact 降级 5 / 输入键盘 4 / 对话区 4）。
`npm run build`：零 TS 错误。

（进行中：S4 线路与直方图渲染器 / S5 DAG 与硬件拓扑。）

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
