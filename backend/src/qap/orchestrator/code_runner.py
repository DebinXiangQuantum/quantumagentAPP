"""classical 代码分发执行器——代码在计算节点机器上真实执行（v1.7）。

语义（用户产品级要求）：classical 步携带 ``workload.code``（Python 源码）
时，后端**只分发不执行**——代码经 NodeWorkerClient 送至节点机器上的
node worker（HTTP /execute），由节点自己的 Python 环境真实子进程执行
（可选装包、限时强杀、实测时长/峰值 RSS）。执行结果写入
``step.workload["result"]``（query_task_results 可读回，形成
"提交→执行→读回"闭环）；``duration_ms`` 由调度器 perf_counter 统一实测。

节点选择：``workload.node_id`` 显式指定 → 调度器租约节点（step.node_id）
→ 首个支持代码执行且在线的 cpu/gpu 节点。无 code 的 classical/quantum/
agent 步 → 委托 fallback（既有 runner 语义不变）。
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

from qap.compute.worker_client import NodeWorkerClient
from qap.domain.models import Step
from qap.hardware.registry import NodeRegistry

#: StepRunner 协议签名（与 CloudStepRunner 一致）
StepRunnerFn = Callable[[Step], Awaitable[str]]

#: 代码执行缺省超时（秒）——workload.timeout_s 可覆盖；上限对齐 worker
DEFAULT_CODE_TIMEOUT_S = 120.0
MAX_CODE_TIMEOUT_S = 900.0


class CodeDispatchRunner:
    """调度器 runner 装饰器：classical code 步 → 节点 worker 分发。"""

    def __init__(
        self,
        registry: NodeRegistry,
        fallback: StepRunnerFn,
        *,
        client_factory: Callable[[str], NodeWorkerClient] = NodeWorkerClient,
    ) -> None:
        self._registry = registry
        self._fallback = fallback
        # client_factory 注入点：测试传 ASGI 直连客户端；生产按 URL 构造
        self._client_factory = client_factory
        self._clients: dict[str, NodeWorkerClient] = {}

    def _select_node(self, workload: dict, step: Step) -> tuple[str | None, str | None]:
        """实例方法壳：转发模块级选择逻辑（保持类接口内聚）。"""
        return _select_node(self._registry, workload, step)

    async def __call__(self, step: Step) -> str:
        workload = step.workload or {}
        code = workload.get("code")
        if step.kind != "classical" or not isinstance(code, str) or not code.strip():
            return await self._fallback(step)
        node_id, exec_url = self._select_node(workload, step)
        if node_id is None or exec_url is None:
            raise RuntimeError(
                "classical 代码执行需要计算节点：未找到已配置执行端点（exec_url）"
                "且在线的 cpu/gpu 节点——请在硬件配置中为计算节点登记 exec_url"
                "（节点机器运行 qap.compute.node_worker）"
            )
        timeout_s = _positive_float(workload.get("timeout_s"), DEFAULT_CODE_TIMEOUT_S)
        timeout_s = min(timeout_s, MAX_CODE_TIMEOUT_S)
        packages = _string_list(workload.get("packages"))
        client = self._clients.setdefault(exec_url, self._client_factory(exec_url))
        result = await client.execute(code, timeout_s=timeout_s, packages=packages)
        # 结果回流：workload.result（完整 dict，含 exit_code/stdout/stderr/
        # duration_ms/peak_rss_mb/timed_out）+ stdout 末行 JSON 便捷字段
        step.workload = {**workload, "result": result, "node_exec": node_id}
        exit_code = result.get("exit_code")
        if exit_code != 0:
            stderr = str(result.get("stderr") or "")[:400]
            raise RuntimeError(
                f"计算节点 {node_id} 代码执行失败（exit={exit_code}）：{stderr}"
            )
        detail = (
            f"计算节点 {node_id} 真实执行（node-observed）：exit=0，"
            f"节点实测 {result.get('duration_ms')}ms，"
            f"峰值 RSS {result.get('peak_rss_mb')}MB，"
            f"stdout {len(str(result.get('stdout') or ''))} 字符"
        )
        return detail


def _select_node(
    registry: NodeRegistry, workload: dict, step: Step
) -> tuple[str | None, str | None]:
    """节点选择：显式 > 租约 > 首个可执行在线节点；返回 (id, exec_url)。"""
    wanted = workload.get("node_id")
    candidates: list[str] = []
    if isinstance(wanted, str) and wanted.strip():
        candidates.append(wanted.strip())
    if step.node_id:
        candidates.append(step.node_id)
    for node_id in candidates:
        node = registry.find(node_id)
        if node is not None and node.kind in ("cpu", "gpu"):
            url = registry.exec_endpoint(node_id)
            if url and node.status == "online":
                return node_id, url
    for node_id in registry.code_capable_ids():
        return node_id, registry.exec_endpoint(node_id)
    return None, None


def _positive_float(raw: object, default: float) -> float:
    """超时参数防御解析：非正/畸形回退默认。"""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return default
    value = float(raw)
    return value if value > 0 else default


def _string_list(raw: object) -> list[str]:
    """包列表防御解析：非字符串列表 → 空（worker 侧再校验内容）。"""
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str) and item.strip()]


__all__ = ["CodeDispatchRunner", "DEFAULT_CODE_TIMEOUT_S"]
