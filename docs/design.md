# QuantumAgentApp 前端设计系统与视觉验收标准

> 目标：专业科学软件的质感（参照 Q-CTRL Boulder Opal、Linear、Grafana 的信息
> 密度与布局节奏），**不允许"AI 生成的粗糙感"**。本文件是前端代码评审与视觉
> 验收的硬标准；所有视觉决策必须追溯到本文的 token 与规则。

## 1. 设计原则

1. **单一来源**：一切颜色/字号/间距/圆角/阴影/动效定义在
   `frontend/src/styles/tokens.ts`（导出 CSS 变量），组件中禁止 magic number。
2. **信息密度优先**：科学工具不是营销页；紧凑但有序，留白服务于分组层级。
3. **数据即等宽**：测量计数、比特串、GPU 型号、qubit 索引、时间戳一律
   `--font-data`，数字对齐是精致度的一半。
4. **五态完备**：每个可交互元素必须实现 default / hover / active /
   focus-visible / disabled 五态；每个数据区域必须有 loading(骨架) / empty /
   error 三种非理想态。
5. **克制的动效**：过渡 ≤ 200ms、ease-out；尊重 `prefers-reduced-motion`。

## 2. 色板（深空暗色主题）

| token | 值 | 用途 |
|---|---|---|
| `--bg-base` | `#0B0E14` | 页面底色 |
| `--bg-surface` | `#11151F` | 卡片/面板 |
| `--bg-elevated` | `#161B28` | 弹层/抽屉/悬浮 |
| `--bg-inset` | `#0D1117` | 代码块/数据表内嵌区 |
| `--border-default` | `#232A3A` | 常规描边 |
| `--border-strong` | `#2E3A50` | 强调描边/hover |
| `--text-primary` | `#E8ECF4` | 主文本 |
| `--text-secondary` | `#9AA4B8` | 次级文本 |
| `--text-faint` | `#5C667A` | 装饰性文字/禁用（占位/副行等有效信息一律用 `--text-secondary`，2026-10-13 视觉评审修订：faint 对深色底不足 4.5:1） |
| `--accent-cyan` | `#4FD8EB` | 主强调（量子/链接/选中） |
| `--accent-violet` | `#8B7CF6` | 次强调（quantum 类步骤/线路） |
| `--success` | `#3DD68C` | 成功/succeeded |
| `--warning` | `#F5B455` | 运行中/agent 类步骤 |
| `--danger` | `#F26D6D` | 失败/错误 |
| `--info` | `#5CA8FF` | 经典计算/classical 类步骤 |

语义映射：Step `kind` → `quantum=violet`、`classical=info`、`agent=warning`；
Node `kind` → `gpu=accent-cyan`、`qpu=accent-violet`、`cpu=text-secondary`。
对比度要求：正文对 `--bg-surface` ≥ 7:1，次级 ≥ 4.5:1（WCAG AA/AAA）。

### §2.1 多主题（v1.1：浅色 / 深色 / 护眼，`<html data-theme="…">` 切换）

深色为默认（上表）；浅色与护眼（sepia）**只覆盖颜色 token**，几何/字号/间距
token 三主题共用。实现于 `tokens.ts` 的 `buildTokenCss()`：输出
`:root{…}`（=dark）+ `[data-theme="light"]{…}` + `[data-theme="sepia"]{…}`。
所有组件继续只引用 `var(--*)`（既有铁律），SVG 可视化同理——主题天然全局生效。

| token | light | sepia（护眼） |
|---|---|---|
| `--bg-base` | `#F5F7FA` | `#F5F0E1` |
| `--bg-surface` | `#FFFFFF` | `#FBF7EC` |
| `--bg-elevated` | `#FFFFFF` | `#FFFCF2` |
| `--bg-inset` | `#EEF1F6` | `#EFE7D2` |
| `--border-default` | `#D9DFEA` | `#E0D5B8` |
| `--border-strong` | `#C6CFDE` | `#CBBE9C` |
| `--text-primary` | `#1F2733` | `#3E3A2F` |
| `--text-secondary` | `#5A6577` | `#6E6753` |
| `--text-faint` | `#8B95A6` | `#6B6249`（2026-10-13 走查修订：原 #998F76 对纸底不足 4.5:1） |
| `--accent-cyan` | `#0E8A9E` | `#2A7F8F` |
| `--accent-violet` | `#6C5CE7` | `#7B6FD0` |
| `--success` | `#1F9D66` | `#3E7345`（走查修订：原 #4E8A52 在线徽标对比不足） |
| `--warning` | `#C77F1D` | `#B07C28` |
| `--danger` | `#D24E4E` | `#B5544A` |
| `--info` | `#2E7CD6` | `#3D6FA8` |

浅色/护眼下阴影降为 `0 1px 2px rgba(15,23,42,.08)` 档（`--shadow-1/2` 同名
覆盖）；对比度门槛同 §2（正文 ≥7:1、次级 ≥4.5:1，两套新主题逐一达标）。

### §2.2 多语言（v1.1：中文 / English / 日本語）

- 轻量自研 i18n：`src/i18n/`（`zh.ts`/`en.ts`/`ja.ts` 字典 + `t(key, params?)`），
  不引入 i18next 等重依赖；语言存 uiStore + localStorage，切换即时生效。
- **只覆盖界面 chrome 文案**（顶栏/侧栏/设置页/空态/按钮/标签/主题名等）；
  用户与 Agent 产生的内容（消息、任务名、Artifact 标题）不做翻译。
- 字体栈三语言通用（微软雅黑/Arial + PingFang SC；日文回退到系统日文字体，
  栈尾 sans-serif 兜底已覆盖）；等宽/衬线用途不变。

## 3. 字体（用户指定，逐字执行）

```css
--font-ui:    "Microsoft YaHei", "微软雅黑", "PingFang SC", Arial, "Helvetica Neue", sans-serif;
--font-data:  "JetBrains Mono", Consolas, "SF Mono", Menlo, monospace;
--font-serif: "Times New Roman", Times, serif;
```

- **中文正文 = 微软雅黑**（Windows）；macOS 无此字体，`PingFang SC`（苹方）
  兜底——font-family 按字符逐个回退，中英混排自动分工。
- **英文界面字 = Arial**；**Times New Roman 仅用于公式/学术报告渲染区**
  （衬线体用于全局 UI 会产生"Word 文档感"，与精致目标冲突）。
- 数据场景（计数/比特串/型号/索引/代码）一律 `--font-data`。
- **不引入 webfont 文件**：系统字体栈零体积、零授权问题、零 FOIT。
- 字号阶（仅此 5 档）：`--fs-caption:12px` `--fs-body:13px` `--fs-body-lg:15px`
  `--fs-title:18px` `--fs-display:22px`；行高：正文 1.6，数据 1.45，标题 1.3。

## 4. 间距 / 圆角 / 阴影 / 层级

- 间距（8px 网格）：`4 / 8 / 12 / 16 / 24 / 32 / 48`。
- 圆角：控件 `--radius-sm:6px`、卡片 `--radius-md:10px`、面板 `--radius-lg:14px`。
- 阴影（双层、低饱和）：
  `--shadow-1: 0 1px 2px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.03)`；
  `--shadow-2: 0 8px 24px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04)`。
- z-index 阶：`--z-base:0 / --z-sticky:10 / --z-drawer:100 / --z-toast:200`。

## 5. 布局（三栏 + 顶栏，v1.1 修订）

```
┌──────── 56px 顶栏：产品名 · 模型选择器 · 思考程度 · 租户 · 连接状态 ────────────────┐
├──────────┬──────────────────────────────────────┬──────────────────────────┤
│ 会话侧栏   │            对话区（流体，max 820px）      │  检查器 360px（可折叠）      │
│ 264px    │  消息流（含思考过程折叠块）· Artifact 卡片  │  Tab: 硬件拓扑│任务 DAG      │
│ (可折叠)   │  ─────────────────────────────        │  （详情抽屉从右滑入）        │
│ 底部:     │  输入区：多行 + 发送(⏎)                  │                          │
│ ⚙ 设置    │                                      │                          │
└──────────┴──────────────────────────────────────┴──────────────────────────┘
```

- **v1.1 顶栏**：移除 Agent 选择器（编排 Agent 自动调度，用户不选）；改为
  **模型选择器**（渠道池列表）+ **思考程度选择器**（off/low/high/max，
  跟随所选渠道 default_thinking）；两者随消息发送（`model_ref`/`thinking_level`）。
- **v1.1 侧栏底部设置入口**：齿轮 + 「设置/Settings/設定」→ 设置页覆盖左栏+对话区
  （检查器保留），含三个分区：
  1. **外观**：主题（浅色/深色/护眼，三选一卡片即时预览）+ 语言（中/EN/JA）；
  2. **模型与思考**：默认模型、默认思考程度（全局默认，写入偏好）；
  3. **提供商渠道**（admin API）：渠道列表（ref/provider/model/base_url/
     密钥已设置√/default_thinking）+ 新建/编辑表单（api_key 仅写入框，
     保存后永不回显）；
  4. **插件管理**（v1.1）：已装插件列表（名称/版本/启用开关/来源 builtin·installed/
     broken 原因）+ 「安装插件」（输入本地 source_path 调 install）+ 卸载。
- 断点：<1280px 检查器浮层化；<960px 侧栏抽屉化；不追求移动端（科学工具）。
- 对话气泡：用户右对齐 `--bg-elevated`；助手左对齐无底色、以头像+细分隔线分组；
  **思考过程（v1.1）**：助手消息顶部"🧠 思考过程"折叠块（默认收起，一行摘要+
  chevron；展开后 mono/caption、--text-secondary、max-height 240px 内滚动）；
  Artifact 卡片通栏，带类型徽标（线路/计数/波形）与展开收起。

### §5.1 截断与压缩规则（v1.1 修订——修复"标题被压缩看不见"）

- 长文本容器一律 `{min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap}`（单行）或 `-webkit-line-clamp`（多行）；flex 子项必须
  `min-width: 0`，否则被压缩到 0 宽不可见（本次边栏/DAG 的根因）。
- **DagView 节点（v1.1）**：宽 232px、高 76px；名称最多 2 行（line-clamp:2），
  id/节点号单行截断；任务标题（header）`min-width: 0` + 截断，徽标不换行。
- **会话侧栏条目**：标题单行截断 + `min-width: 0`；副行同。

## 6. 可视化组件规范（全部手写 SVG，禁用图表库）

1. **CircuitCanvas**：qubit 横线自上而下编号（等宽字体标签 `q0…`）；门为格点方块，
   单位格 44×36px；多量子门竖线连接；MEASURE 画表针符号；列压缩无空列；
   悬停门高亮 + tooltip 显示 gate/参数；>32 qubits 提示并截断。
2. **CountsHistogram**：横轴比特串（等宽）、纵轴概率（counts/shots）；
   条形从基线生长动画 160ms；hover 显示计数与占比；总 shots 显示于副标题；
   最大值归一化不变量：`max(高度)/绘图高 == max(counts)/max_count`。
3. **DagView**：**纵向流水线布局**（依赖层自上而下堆叠、同层并排；2026-10-13
   修订——横向布局在 360px 检查器上溢出且画布高度塌缩）。节点 = Step
   （kind 色 + 状态图标 + 等宽 id）；边 = 依赖（箭头，竖向贝塞尔）；
   运行中节点呼吸光晕（2s 循环，reduced-motion 时改为实线描边）；
   点击节点 → 右侧详情（node_id、起止时间、detail/error）。
4. **HardwareTopology**：按 kind 分组的卡片网格；GPU/QPU 卡显示型号、容量点、
   利用率迷你条（60s 滚动）、活动 allocation 徽标（"algorithm-designer · t-1/s-2"）；
   点击卡片 → Drawer：节点全量信息 + 该节点历史任务；离线节点降饱和 + 斜纹。
5. **状态徽标体系**：pending(空心) / running(warning 呼吸) / succeeded(success) /
   failed(danger) / cancelled(faint)，全组件统一复用同一 `StatusBadge`。

## 7. 交互与动效细则

- 过渡：`--motion-fast:120ms`、`--motion-panel:200ms`，缓动 `cubic-bezier(.2,.7,.3,1)`。
- 流式光标：assistant 末尾 1px 宽闪烁条（530ms 步进），完成后淡出。
- 骨架屏：shimmer 1.2s 循环，占位结构与真实内容同构（非通用灰块）。
- 空状态：插画式文案（如"暂无硬件分配——发送一条消息让 Agent 开始工作"）+ 行动按钮。
- 错误态：内联警示条 + 重试按钮；SSE 断线自动重连（指数退避，上限 30s），
  顶栏连接状态灯（绿/黄/红）。

## 8. 视觉验收清单（合并前逐项打勾）

- [ ] 无任何组件内硬编码颜色/字号/间距（全部 token 化，评审 grep 校验）。
- [ ] 字体栈与 §3 逐字一致；数据区全部等宽；无 webfont 引入。
- [ ] 五态 × 主要交互元素（按钮/输入/Tab/卡片/节点）全数实现。
- [ ] loading/empty/error 三态 × 每个数据区域全数实现。
- [ ] 四个可视化组件通过各自"映射不变量"测试（§6.2 等）。
- [ ] 暗色主题下对比度达标（§2）；无纯白/纯黑大色块。
- [ ] 动效全部 ≤200ms 且有 reduced-motion 降级。
- [ ] 截图走查：与 Q-CTRL/Linear/Grafana 并排对比，无"模板拼凑感"。

## References

- MDN font-family 与字体回退机制（按字符逐个匹配的事实来源）:
  https://developer.mozilla.org/en-US/docs/Web/CSS/font-family
- Microsoft typography（Microsoft YaHei 为 Windows 系统字体的事实来源）:
  https://learn.microsoft.com/typography/font-list/microsoft-yahei
- Apple Platform Fonts（PingFang SC 为 macOS 中文字体，兜底依据）:
  https://developer.apple.com/fonts/system-fonts/
- CSS Custom Properties（token 实现方式）:
  https://developer.mozilla.org/en-US/docs/Web/CSS/--*
- prefers-reduced-motion（动效降级依据）:
  https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- WCAG 2.1 对比度（AA/AAA 阈值事实来源）: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
- Q-CTRL Boulder Opal（信息密度与可视化布局的**工程参照**，非代码来源）:
  https://q-ctrl.com/boulder-opal
- Qiskit circuit drawer（线路绘制惯例：横线 qubit、格点门、测量表针）:
  https://qiskit.org/documentation/apidoc/visualization.html

> 声明：字体可用性、回退机制、对比度阈值为文献事实；配色具体值、布局尺寸、
  组件风格均为本仓库工程选择，以实现与测试为准。
