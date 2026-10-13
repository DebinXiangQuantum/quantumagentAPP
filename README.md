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

## 前端 (Frontend)

*本节由 `feat/frontend` 分支的开发切片维护更新：组件清单、页面说明、测试结果。*

（基线：尚未实现——见 `docs/design.md` 的目标设计。）

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
