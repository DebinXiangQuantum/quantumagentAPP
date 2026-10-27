# AGENTS.md — 开发规范与 Git 提交纪律

本文档是所有参与本仓库开发的 Agent（人类或 AI）必须遵守的规范。

## 1. 代码规范

### 1.1 文档与注释
- **每个模块 / 类 / 函数必须有描述性 docstring**（前端组件用文件头注释块：职责、Props 契约、交互行为）。
- 非平凡代码块必须有就近详细注释，覆盖：目的、单位、假设、失败行为。
- 禁止让数值内核或不透明分支无注释存在。

### 1.2 文件与结构
- 文件保持聚焦：**优先 <400 行，硬上限 700 行**。超限必须拆分。
- 公开函数一律使用类型注解（Python type hints / TypeScript types），并对畸形 / 非有限输入抛出明确异常。
- 禁止隐藏单位换算与"从抽象哈密顿量猜硬件参数"式的隐式假设。

### 1.3 数据诚实性
- 区分三种数据来源，在代码注释和 UI 中标注：
  - `simulated` — 本地模拟
  - `measured` — 真实执行的真实测量（如 perf_counter / tracemalloc）
  - `cloud-observed` — 云端真机观测（logicalcloud QPU 计数 / 标定）
- **禁止将输出分布相似性表述为量子态/过程保真度**（文档措辞规则）。
- 禁止编造执行结果——计数未返回时明确说明等待中。

## 2. 测试纪律（TDD）

**先写失败测试，再写实现，再提交。** 每个功能切片必须覆盖四类场景：

| 类别 | 含义 |
|------|------|
| **不变量** | 数学/物理守恒（DAG 无环、counts 总和 = shots、t2 ≤ 2·t1） |
| **非法输入拒绝** | 坏 config / 坏 artifact / NaN / 越界 qubit → 422/ValueError |
| **负样本** | 超时、断流、超配额(429)、跨租户(404)、节点离线 |
| **可观察行为** | SSE 事件顺序、HTTP 状态码、stdout 内容 |

### 提交前必须运行

```bash
cd backend && source .venv/bin/activate && pytest -q
cd frontend && npm test
```

**全部通过才允许 commit。** 不允许跳过测试或注释掉失败的测试。

## 3. Git 提交纪律

### 3.1 提交格式

```
<scope>: <一句话祈使句摘要>

- 具体变更点 1（文件/函数/行为）
- 具体变更点 2
- ...

验证：<测试命令与结果>
遗留：<已知缺陷，无则写"无">
```

scope ∈ `backend | frontend | docs | deploy | fix | merge | integration`

### 3.2 必须随提交更新的文件

每次提交**必须**同时更新：

- `README.md` — 本分支负责的章节（模块清单/运行方式/测试结果）
- `change.log` — 新增条目（Added / Changed / Fixed + Validation + Known defects）

### 3.3 分支模型

```
main          ← 集成分支（只接受测试通过的切片合并）
feat/backend  ← 后端开发
feat/frontend ← 前端开发
```

- 并行开发使用隔离 worktree：`git worktree add ../<repo>-wt-backend feat/backend`
- 集成顺序：先 backend → main，再 frontend → main（README/change.log 冲突由集成者拼接）

### 3.4 禁止提交清单

**绝对不提交**（违反 = revert + 通报）：

| 类别 | 文件 |
|------|------|
| 密钥 | `.env*`, `*.pem`, `*.key`, `secrets/` |
| 本地配置 | `config.local.toml` |
| 运行时数据 | `backend/data/`, `runs/`, `logs/` |
| 依赖 | `node_modules/`, `.venv/`, `__pycache__/` |
| 构建产物 | `dist/`, `coverage/`, `.pytest_cache/` |

提交前必须 `git status` 目检 + `git diff --cached | grep -i "key\|secret\|password"` 扫描。

## 4. 架构契约（关键摘要）

完整契约见 `docs/ARCHITECTURE.md`。以下是最常触碰的核心约定：

### 4.1 API 路径前缀 `/api/v1/`
### 4.2 SSE 事件名
`message.delta` / `message.reasoning` / `message.completed` / `agent.activity` / `artifact.created` / `task.updated` / `error`

### 4.3 Artifact 类型
`circuit`（门级线路 JSON）/ `counts`（测量计数）/ `waveform`（校准波形）

### 4.4 前端设计 Token
一切颜色/字号/间距/字体定义在 `frontend/src/styles/tokens.ts`（唯一来源），组件中**禁止**出现 magic number。

### 4.5 配置
一切平台配置集中于根目录 `config.toml`；密钥经 `api_key_env` 指向环境变量。

## 5. References

- [Conventional Commits](https://www.conventionalcommits.org/) — 提交信息格式参照
- [Git Worktree](https://git-scm.com/docs/git-worktree) — 并行开发隔离
- [pytest](https://docs.pytest.org/) / [Vitest](https://vitest.dev/guide/) — 测试框架
- [TDD 实践](http://www.jamesshore.com/v2/books/aodr/testing/test-first-programming)
