# QuantumAgentApp

异构量子智能体平台——对话式交互 + 真机 QPU + GPU/CPU 计算节点 + 实时可视化。

## 概述

本平台提供前后端完整框架，让量子领域智能体（量子校准、算法设计、容错编程等）以**插件**形式接入，通过对话页面完成从问题建模、算法设计、量子线路生成到真机执行的全流程。

### 核心能力

| 能力 | 说明 |
|------|------|
| **对话式编排** | orchestrator 编排 Agent 自主调度领域专家（`dispatch_agent`，深度=1） |
| **真机 QPU** | logicalcloud 实拉真机（MQ02/AGate-100 等 10 台），量子步真实提交执行，SABRE 噪声自适应路由 |
| **计算节点执行** | A100/H100 GPU 节点 node worker——classical 步携带 Python code 真实子进程执行（后端只分发） |
| **可视化** | IBM 风格芯片拓扑（云端标定 T1/T2/保真度着色）、量子线路 SVG、计数直方图、DAG 时间线 Gantt |
| **子 Agent 线程** | Codex 风格完整子线程抽屉（思考全文/输出/工具参数/时间线） |
| **持久化** | SQLite（零依赖标准库，WAL，重启不丢） |
| **多模型** | OpenAI 格式 + Anthropic 格式双 provider，管理页面可视化管理渠道池 |

## 快速开始

### 后端

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,hardware]"
PYTHONPATH=src uvicorn qap.main:app --port 8000
```

需要设置 `GLM_API_KEY` 环境变量（或 `config.local.toml` 配置其他渠道）。

### 前端

```bash
cd frontend
npm install && npm run dev    # http://localhost:5173
```

或构建后由后端同源托管：

```bash
npm run build
QAP_FRONTEND_DIR=../frontend/dist PYTHONPATH=src uvicorn qap.main:app
```

### 配置

一切配置集中于根目录 `config.toml`（密钥经环境变量引用，绝不入库）：

```toml
[models.default]
provider = "openai"        # 或 "anthropic"
model = "glm-5.3"
base_url = "https://open.bigmodel.cn/api/coding/paas/v4"
api_key_env = "GLM_API_KEY"

[storage]
backend = "sqlite"          # 或 "memory"（开发/测试）
db_path = "data/qap.db"
```

## 仓库结构

```
├── config.toml          # 全局唯一配置入口
├── docs/                # 架构契约与设计系统
│   ├── ARCHITECTURE.md  # API/SSE/Artifact/插件/Provider 契约
│   ├── design.md        # 前端设计系统（色板/字体/布局/交互）
│   └── DEVELOPMENT.md   # 分支模型/worktree/测试纪律
├── backend/             # FastAPI + Python 3.11+
│   └── src/qap/
│       ├── agents/      # 运行时/插件/Provider（openai/anthropic）
│       ├── api/         # REST 路由 + SSE
│       ├── domain/      # 模型/校验/SQLite 持久化
│       ├── hardware/    # 注册表/分配器/lqcloud 适配/SABRE 编译
│       └── orchestrator/# DAG 校验/调度器/云端 runner/代码分发
├── frontend/            # React 18 + TS + Vite（无 UI 库/图表库）
│   └── src/
│       ├── components/  # chat/viz/layout/settings
│       ├── api/         # REST + SSE 客户端
│       ├── store/       # zustand
│       └── i18n/        # 中/英/日三语
└── AGENTS.md            # Agent 开发规范
```

## 测试

```bash
cd backend && pytest              # 532 tests
cd frontend && npm test           # 229 tests
```

## 生产部署

```bash
# 服务器上
/opt/qap/start-env.sh            # uvicorn 0.0.0.0:8070
systemctl start qap               # systemd 持久化
```

## References

- [pi-agent-core](https://github.com/earendil-works/pi) — 统一 LLM API 设计参照
- [OpenAI Chat API](https://platform.openai.com/docs/api-reference/chat) / [Anthropic Messages API](https://docs.anthropic.com/en/api/messages-streaming)
- [FastAPI](https://fastapi.tiangolo.com/) / [SSE (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [logicalcloud](https://cloud.logicalqubit.com) — 真机 QPU 云平台
- [Qiskit](https://qiskit.org/documentation/apidoc/visualization.html) — 线路绘制惯例
