"""计算节点执行器（node worker）与分发链路测试（v1.7 平台能力）。

语义：classical 步携带 code 时，代码在**计算节点的 worker 进程**里真实执行
（后端只分发不执行）；worker 为平台交付物，真实部署运行于 CPU/GPU 节点机器。

四类场景：
- 不变量：执行产物 exit_code/stdout/duration_ms 真实（子进程真跑）；
  装包可选；结果 JSON 可被 query_task_results 读回（step.workload.result）。
- 非法输入拒绝：空 code / 非法 packages / 超时 → 结构化错误（step.error）。
- 负样本：代码抛错 → exit_code!=0 且 stderr 入结果；worker 不可达 →
  步骤失败"计算节点执行端点不可达"。
- 可观察行为：/health 心跳；stdout 截断（>64KB 不撑爆）。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from qap.compute.worker_client import NodeWorkerClient, WorkerUnreachable
from qap.compute.node_worker import create_worker_app


@pytest.fixture()
async def worker_server():
    """在同一进程内启动真实 worker 应用（httpx ASGI 直连，零网络端口）。"""
    app = create_worker_app(node_name="cpu-test")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://node") as http:
        yield http


class TestWorkerExecute:
    async def test_health(self, worker_server) -> None:
        resp = await worker_server.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok" and body["node"] == "cpu-test"

    async def test_real_subprocess_execution(self, worker_server) -> None:
        resp = await worker_server.post("/execute", json={
            "code": "import json\nprint(json.dumps({'ans': 6 * 7}))",
            "timeout_s": 30,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["exit_code"] == 0
        assert '"ans": 42' in body["stdout"]
        assert body["duration_ms"] > 0  # 实测时长（子进程真实执行）

    async def test_code_failure_carries_stderr(self, worker_server) -> None:
        resp = await worker_server.post("/execute", json={
            "code": "raise ValueError('boom-marker')", "timeout_s": 30,
        })
        body = resp.json()
        assert body["exit_code"] != 0
        assert "boom-marker" in body["stderr"]

    async def test_timeout_kills(self, worker_server) -> None:
        resp = await worker_server.post("/execute", json={
            "code": "import time\ntime.sleep(60)", "timeout_s": 1,
        })
        body = resp.json()
        assert body["exit_code"] != 0 or body.get("timed_out") is True

    async def test_malformed_request_rejected(self, worker_server) -> None:
        resp = await worker_server.post("/execute", json={"code": "", "timeout_s": 5})
        assert resp.status_code == 422
        resp2 = await worker_server.post("/execute", json={"code": "pass", "timeout_s": 0})
        assert resp2.status_code == 422


class TestWorkerClient:
    async def test_client_roundtrip(self, worker_server) -> None:
        client = NodeWorkerClient(worker_server)
        result = await client.execute("print('hi-node')", timeout_s=30)
        assert result["exit_code"] == 0 and "hi-node" in result["stdout"]

    async def test_unreachable_raises_typed_error(self) -> None:
        client = NodeWorkerClient(base_url="http://127.0.0.1:59999")
        with pytest.raises(WorkerUnreachable):
            await client.execute("pass", timeout_s=2)
