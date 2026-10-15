"""qap —— QuantumAgentApp 后端包。

平台承载多类量子领域智能体，但平台本身不实现领域算法，只提供：
对话交互、租户管理、任务编排（DAG）、并行调度、异构硬件注册与分配、
统一 LLM Provider（openai / anthropic 两种真实 wire format——v1.6 起
产品无 mock 渠道，测试替身只在 tests/）、SSE 实时事件。

架构契约的唯一事实来源是仓库根 docs/ARCHITECTURE.md；本包内任何 API 路径、
SSE 事件名、Artifact JSON 结构、配置键名均不得偏离该契约。
"""

__version__ = "0.1.0"
