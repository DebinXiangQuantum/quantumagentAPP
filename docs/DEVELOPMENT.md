# 开发流程规范（QuantumAgentApp）

本文件把项目协作规则固化为可执行流程；违反任何一条都视为切片未完成。

## 1. 分支模型与 worktree 隔离

- `main`：集成分支，只接受经过测试的切片合并，保持随时可运行。
- `feat/backend`：后端开发分支（Python 3.11+ / FastAPI，包名 `qap`，位于 `backend/`）。
- `feat/frontend`：前端开发分支（React 18 + TS + Vite，位于 `frontend/`）。
- 并行开发使用**隔离 worktree**（互不污染工作区）：

```bash
git worktree add ../quantumagentapp-wt-backend  feat/backend
git worktree add ../quantumagentapp-wt-frontend feat/frontend
# 各子代理只在自己的 worktree 内工作、提交；主 worktree 仅做集成
```

- 集成顺序：先 `feat/backend` → `main`，再 `feat/frontend` → `main`；
  README.md / change.log 的合并冲突由集成者手工拼接（双方各自维护自己的小节）。

## 2. 切片纪律

1. **小切片**：一次提交 = 一个可测试的完整功能增量；禁止巨型提交。
2. **TDD**：先写失败测试，再写实现，再提交。测试必须覆盖四类场景：
   数学/物理不变量、非法输入拒绝、噪声/负样本（超时、断流、超配额、离线）、
   可观察行为（事件顺序、HTTP 状态码）。
3. **每次提交必须更新** 根目录 `README.md`（本分支负责的小节）与 `change.log`
   （新增条目：Added/Changed/Fixed + Validation + Known defects）。
   Commit body 用一段话描述全部新增/变更功能。
4. 提交信息格式：`<scope>: <祈使句摘要>`，scope ∈ {backend, frontend, docs, chore}。

## 3. 代码质量规则（全局生效）

- 每个模块/类/函数都有描述性 docstring（前端组件用文件头注释块：职责、props、
  交互）；非平凡代码块就近详细注释：目的、单位、假设、失败行为。
- 文件聚焦：**优先 <400 行，硬上限 700 行**；超限即拆分。
- 公开函数一律类型注解，并对畸形/非有限输入抛出明确异常（前端组件对畸形
  props 走降级渲染而非崩溃）。
- 禁止隐藏单位换算与"从抽象哈密顿量猜硬件参数"式的隐式假设。
- 不把输出分布相似性表述为量子态/过程保真度（文档措辞规则）。

## 4. 禁止提交清单

- 任何真实密钥 / 完整 provider 连接配置（密钥只经 `api_key_env` 环境变量引用）。
- 运行时生成目录：`runs/ logs/ node_modules/ dist/ .venv/ __pycache__/ coverage/`。
- 上述由 `.gitignore` 兜底，但提交前仍须 `git status` 目检。

## 5. 本地验证命令（集成门槛）

```bash
# 后端
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && pytest
PYTHONPATH=src uvicorn qap.main:app &   # 冒烟：curl /api/v1/health

# 前端
cd frontend && npm install
npm run build && npm test
VITE_USE_MOCK=1 npm run dev             # Mock 演示模式
```

## 6. 文档规则

- 每个 Markdown 文档（含 skill）必须有 **References 小节**，区分：文献事实 /
  工程选择 / 模拟结果 / 硬件观察；引用不构成对实现的证明。
- 迁移代码必须注明出处（provenance）。

## References

- Git worktree 官方文档（隔离工作区机制）:
  https://git-scm.com/docs/git-worktree
- pytest（后端测试框架）: https://docs.pytest.org/
- Vitest（前端测试框架）: https://vitest.dev/guide/
- Conventional Commits（提交信息格式参照）: https://www.conventionalcommits.org/
- 《The Art of Agile Development》测试先行实践（TDD 流程参照）:
  http://www.jamesshore.com/v2/books/aodr/testing/test-first-programming
