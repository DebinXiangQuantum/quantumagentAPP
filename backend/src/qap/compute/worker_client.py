"""节点执行客户端——后端调度器 → 计算节点 worker 的 HTTP 分发。

后端**只分发不执行**（v1.7）：classical 步的 code 经此客户端送达节点
机器上的 worker；结果（exit/stdout/实测时长/峰值 RSS）写回步骤。
不可达/超时 → WorkerUnreachable（调度器转 step.error，不崩平台）。
"""

from __future__ import annotations

from typing import Any

import httpx


class WorkerUnreachable(RuntimeError):
    """节点 worker 不可达/超时/返回非 200——步骤级错误，非平台级。"""


class NodeWorkerClient:
    """单节点 worker 客户端（构造注入 httpx 客户端或 base_url）。"""

    def __init__(
        self,
        client_or_base: "httpx.AsyncClient | str | None" = None,
        *,
        base_url: str | None = None,
    ):
        """构造：注入 AsyncClient（测试/复用）或 base_url（部署直连）。"""
        if base_url is not None:
            self._http = httpx.AsyncClient(base_url=base_url, timeout=900.0)
            self._owns_http = True
        elif isinstance(client_or_base, str):
            self._http = httpx.AsyncClient(base_url=client_or_base, timeout=900.0)
            self._owns_http = True
        else:
            self._http = client_or_base or httpx.AsyncClient(timeout=900.0)
            self._owns_http = client_or_base is None

    async def execute(
        self,
        code: str,
        *,
        timeout_s: float = 120.0,
        packages: list[str] | None = None,
    ) -> dict[str, Any]:
        """分发执行；返回 worker 的结果 dict（形状见 node_worker.ExecuteResult）。"""
        try:
            resp = await self._http.post(
                "/execute",
                json={
                    "code": code,
                    "timeout_s": timeout_s,
                    "packages": packages or [],
                },
            )
        except httpx.HTTPError as exc:
            raise WorkerUnreachable(f"node worker unreachable: {exc}") from exc
        if resp.status_code != 200:
            raise WorkerUnreachable(
                f"node worker returned HTTP {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    async def health(self) -> dict[str, Any]:
        """心跳（部署核对面：节点名 + Python 版本）。"""
        try:
            resp = await self._http.get("/health")
        except httpx.HTTPError as exc:
            raise WorkerUnreachable(f"node worker unreachable: {exc}") from exc
        if resp.status_code != 200:
            raise WorkerUnreachable(f"health returned HTTP {resp.status_code}")
        return resp.json()

    async def aclose(self) -> None:
        """释放自持连接（注入客户端时不持有生命周期）。"""
        if self._owns_http:
            await self._http.aclose()
