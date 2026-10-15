"""S8 端到端集成测试：httpx ASGITransport 走通 §10 演示链路全部 5 步断言。

契约 §10 验收基线（本文件以 HTTP + SSE 的最终形态验证）：
1. 创建会话 → 发消息 → SSE 依序 message.delta… → message.completed
   （含 circuit + counts artifacts）；
2. Assistant 流中调用 submit_task：3 步链式 DAG；
3. Scheduler 按容量分配：quantum → qpu-quanta-20q，classical → cpu-node-0，
   task.updated 逐步推送；
4. hardware.updated 反映 allocation（前端可回答"哪个 Agent 在用哪块 GPU"）；
5. 全程零真实 LLM 调用、零真实硬件依赖（v1.6：产品无 mock 渠道——
   测试以 tests/scripted_provider.py 的 ScriptedTestProvider 替身驱动，
   经 providers 表原地注入；硬件为 simulated 初步验证执行器）。

另含鉴权/配额/跨租户/续传等负样本与可观察行为断言。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from qap.api.state import AppState
from qap.core.config import (
    AgentsConfig,
    AppConfig,
    BuiltinAgentConfig,
    HardwareConfig,
    HardwareNodeConfig,
    ModelConfig,
    SchedulerConfig,
    ServerConfig,
    TenancyConfig,
    TenantConfig,
)
from qap.main import create_app
from tests.scripted_provider import ScriptedTestProvider

DEMO_HEADERS = {"Authorization": "Bearer demo-key"}
OTHER_HEADERS = {"Authorization": "Bearer other-key"}

#: 测试渠道的占位密钥环境变量名（绝不指向真实服务；值无需存在——
#: provider 由 ScriptedTestProvider 原地替换，OpenAI 实例从不发起调用）
TEST_KEY_ENV = "QAP_TEST_SCRIPTED_KEY"


def make_test_config(*, max_messages_per_day: int = 1000) -> AppConfig:
    """集成测试配置：真实 provider 形状的占位渠道、双租户、契约同构硬件。

    v1.6 去 mock 化：models 配置必须是真实 provider（openai）形状——
    base_url 指向不可路由的测试域，密钥读不存在的环境变量；运行时由
    :class:`ClientBundle` 把 ``providers["default"]`` 原地替换为
    ScriptedTestProvider（runtime 闭包共享同一 dict，替换即时生效）。
    """
    return AppConfig(
        server=ServerConfig(host="127.0.0.1", port=8000, cors_origins=[]),
        models={
            "default": ModelConfig(
                provider="openai",
                model="scripted-demo",
                base_url="http://test.invalid/v1",
                api_key_env=TEST_KEY_ENV,
            ),
        },
        agents=AgentsConfig(
            default_model_ref="default",
            plugins_dir="",
            builtin={
                "algorithm-designer": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "calibration": BuiltinAgentConfig(enabled=True, model_ref="default"),
                "echo": BuiltinAgentConfig(enabled=True, model_ref="default"),
            },
        ),
        hardware=HardwareConfig(
            simulated=False,  # 测试关模拟器：SSE 事件流保持确定性
            tick_seconds=60.0,
            nodes=[
                HardwareNodeConfig(id="qpu-quanta-20q", kind="qpu", name="QuANTA 20Q",
                                   model="superconducting-transmon", capacity=1),
                HardwareNodeConfig(id="gpu-a800-0", kind="gpu", name="A800 #0",
                                   model="NVIDIA A800 80GB", capacity=1),
                HardwareNodeConfig(id="cpu-node-0", kind="cpu", name="经典计算节点 #0",
                                   model="EPYC 64C / 256GB", capacity=4),
            ],
        ),
        scheduler=SchedulerConfig(max_parallel_steps=4, step_timeout_seconds=10.0,
                                  retry_failed_steps=False),
        tenancy=TenancyConfig(
            default_tenant="demo",
            tenants=[
                TenantConfig(id="demo", name="Demo 租户", api_key="demo-key",
                             max_concurrent_tasks=2,
                             max_messages_per_day=max_messages_per_day),
                TenantConfig(id="other", name="另一租户", api_key="other-key",
                             max_concurrent_tasks=1, max_messages_per_day=10),
            ],
        ),
    )


class ClientBundle:
    """测试客户端 + 应用状态（负样本需要直接操纵服务）。"""

    def __init__(self, config: AppConfig) -> None:
        self.app: FastAPI = create_app(config)
        self.state: AppState = self.app.state.qap
        # v1.6 测试替身注入：占位 openai 渠道 → ScriptedTestProvider（剧本
        # 驱动 §10 链路；runtime 闭包共享 providers dict，原地替换即时生效）
        self.state.providers["default"] = ScriptedTestProvider()
        transport = httpx.ASGITransport(app=self.app)
        self.http = httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.fixture()
async def bundle(monkeypatch: pytest.MonkeyPatch) -> ClientBundle:
    """默认测试束：加速模拟步骤（0.1s/单位），关闭利用率模拟器。"""
    monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
    instance = ClientBundle(make_test_config())
    yield instance
    await instance.app.state.qap.shutdown()
    await instance.http.aclose()


class _StreamComplete(BaseException):
    """达到读取条件后中止 ASGI 流（派生自 BaseException 以穿透 Starlette
    的 ``except Exception`` 中间件，同时触发 SSE 生成器的 finally 清理）。"""


class Frame:
    """解析后的 SSE 帧。"""

    def __init__(self, raw: str) -> None:
        self.event = "message"
        self.data: Any = {}
        self.id: int | None = None
        for line in raw.splitlines():
            if line.startswith("id:"):
                self.id = int(line[3:].strip())
            elif line.startswith("event:"):
                self.event = line[6:].strip()
            elif line.startswith("data:"):
                self.data = json.loads(line[5:].strip())


async def read_sse(
    bundle: ClientBundle,
    url: str,
    *,
    headers: dict | None = None,
    until=None,
    timeout: float = 6.0,
) -> list[Frame]:
    """直接走原生 ASGI 读 SSE 流，直到 ``until(frames)`` 为真。

    为什么不用 ``client.stream``：httpx 0.28 的 ASGITransport 会把 app
    **跑完**才返回响应——无限 SSE 流因此永远挂起；原生 ASGI 调用可以在
    收到足够 ``http.response.body`` 消息后主动中止。
    """
    path, _, query = url.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": path, "raw_path": path.encode(),
        "query_string": query.encode(),
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or DEMO_HEADERS).items()],
        "server": ("testserver", 80), "client": ("127.0.0.1", 123),
    }
    frames: list[Frame] = []
    meta: dict[str, Any] = {}
    buffer = bytearray()
    request_sent = False

    async def receive() -> dict:
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Event().wait()  # 无后续请求体；保持连接
        raise AssertionError("unreachable")  # pragma: no cover

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            meta["status"] = message["status"]
        elif message["type"] == "http.response.body" and message.get("body"):
            # 帧以空行分隔；UTF-8 多字节字符不会包含 0x0A，字节级切分安全
            buffer.extend(message["body"])
            while True:
                idx = buffer.find(b"\n\n")
                if idx < 0:
                    break
                raw = bytes(buffer[:idx])
                del buffer[: idx + 2]  # 消费已解析部分（否则死循环）
                if raw.strip():
                    frames.append(Frame(raw.decode("utf-8")))
                    if until is not None and until(frames):
                        raise _StreamComplete

    try:
        await asyncio.wait_for(bundle.app(scope, receive, send), timeout=timeout)
        raise AssertionError("SSE 流意外结束（until 条件未满足）")
    except _StreamComplete:
        pass
    assert meta.get("status") == 200
    return frames


async def wait_task_status(bundle: ClientBundle, task_id: str, timeout: float = 8.0) -> dict:
    """轮询任务直至终态（返回终态 Task 快照）。"""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        task = (await bundle.http.get(f"/api/v1/tasks/{task_id}", headers=DEMO_HEADERS)).json()
        if task["status"] in ("succeeded", "failed", "cancelled"):
            return task
        await asyncio.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach terminal status in {timeout}s")


# ---------- 基础端点与鉴权 ----------

class TestBasics:
    async def test_health_without_auth(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok" and body["version"]

    @pytest.mark.parametrize(
        "headers",
        [
            {},  # 缺失
            {"Authorization": "Bearer wrong-key"},  # 未知
            {"Authorization": "demo-key"},  # 非 Bearer 方案
            {"Authorization": "Basic demo-key"},  # 错方案
        ],
    )
    async def test_auth_rejected_401(self, bundle: ClientBundle, headers: dict) -> None:
        response = await bundle.http.get("/api/v1/agents", headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    async def test_disabled_tenant_403(self, bundle: ClientBundle) -> None:
        bundle.state.tenants.set_enabled("demo", False)
        response = await bundle.http.get("/api/v1/agents", headers=DEMO_HEADERS)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "tenant_disabled"

    async def test_agents_list_contract_shape(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/agents", headers=DEMO_HEADERS)
        assert response.status_code == 200
        agents = response.json()
        assert {a["id"] for a in agents} == {
            "algorithm-designer", "calibration", "echo", "orchestrator",
        }
        first = agents[0]
        assert set(first) >= {"id", "name", "description", "capabilities", "model_ref", "builtin"}

    async def test_tenants_me_usage_view(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/tenants/me", headers=DEMO_HEADERS)
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == "demo"
        assert body["usage"]["messages_today"] == 0
        assert body["quota"]["max_concurrent_tasks"] == 2


class TestSseQueryParamAuth:
    """SSE 查询参数鉴权兜底。

    动机：浏览器 ``EventSource`` API 不支持自定义请求头（MDN），前端无法在
    SSE 订阅上携带 ``Authorization: Bearer``；契约 §5 修订——Authorization
    头缺失时接受 ``?api_key=`` 查询参数兜底。头存在时仍以头为准（权威性）。

    注意：read_sse 的 ``headers or DEMO_HEADERS`` 会把空 dict 当"未传"回退，
    故用哑头显式覆盖以构造"无 Authorization"的 scope。
    """

    #: 哑头：使 read_sse 不回退默认鉴权头，真实模拟 EventSource 场景
    NO_AUTH_HEADERS = {"X-Sse-Test": "eventsource"}

    async def test_global_stream_with_query_param_only(self, bundle: ClientBundle) -> None:
        frames = await read_sse(
            bundle,
            "/api/v1/events?api_key=demo-key",
            headers=self.NO_AUTH_HEADERS,
            until=lambda fs: any(f.event == "ping" for f in fs),
        )
        assert any(f.event == "ping" for f in frames)

    async def test_conversation_stream_with_query_param_only(
        self, bundle: ClientBundle
    ) -> None:
        created = await bundle.http.post(
            "/api/v1/conversations",
            headers=DEMO_HEADERS,
            json={"agent_id": "echo", "title": "qp-auth"},
        )
        cid = created.json()["id"]
        frames = await read_sse(
            bundle,
            f"/api/v1/conversations/{cid}/stream?api_key=demo-key",
            headers=self.NO_AUTH_HEADERS,
            until=lambda fs: any(f.event == "ping" for f in fs),
        )
        assert any(f.event == "ping" for f in frames)

    async def test_wrong_query_param_key_401(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/events?api_key=wrong-key")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    async def test_header_takes_precedence_over_query_param(
        self, bundle: ClientBundle
    ) -> None:
        # 头与参数同时存在但头无效：以头为准 → 401（不允许用参数"抢救"坏头）
        response = await bundle.http.get(
            "/api/v1/events?api_key=demo-key",
            headers={"Authorization": "Bearer wrong-key"},
        )
        assert response.status_code == 401


# ---------- 会话 CRUD ----------

class TestConversations:
    async def test_create_list_get(self, bundle: ClientBundle) -> None:
        created = await bundle.http.post(
            "/api/v1/conversations",
            json={"agent_id": "algorithm-designer", "title": "VQE 会话"},
            headers=DEMO_HEADERS,
        )
        assert created.status_code == 201
        conversation = created.json()
        assert conversation["id"].startswith("c-")
        assert conversation["agent_id"] == "algorithm-designer"
        assert conversation["tenant_id"] == "demo"

        listed = (await bundle.http.get("/api/v1/conversations", headers=DEMO_HEADERS)).json()
        assert [c["id"] for c in listed] == [conversation["id"]]

        detail = (
            await bundle.http.get(f"/api/v1/conversations/{conversation['id']}", headers=DEMO_HEADERS)
        ).json()
        assert detail["messages"] == []

    async def test_create_unknown_agent_404(self, bundle: ClientBundle) -> None:
        response = await bundle.http.post(
            "/api/v1/conversations", json={"agent_id": "ghost"}, headers=DEMO_HEADERS
        )
        assert response.status_code == 404

    async def test_create_malformed_body_422(self, bundle: ClientBundle) -> None:
        response = await bundle.http.post(
            "/api/v1/conversations", json={"agent_id": ""}, headers=DEMO_HEADERS
        )
        assert response.status_code == 422

    async def test_get_unknown_conversation_404(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/conversations/c-999", headers=DEMO_HEADERS)
        assert response.status_code == 404

    async def test_limit_param(self, bundle: ClientBundle) -> None:
        for _ in range(3):
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        listed = (
            await bundle.http.get("/api/v1/conversations?limit=2", headers=DEMO_HEADERS)
        ).json()
        assert len(listed) == 2


# ---------- §10 端到端演示链路 ----------

class TestDemoChain:
    async def test_full_demo_chain_five_assertions(self, bundle: ClientBundle) -> None:
        """§10 全部 5 步（SSE 顺序 / DAG / 调度分配 / hardware / 零外呼）。"""
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations",
                json={"agent_id": "algorithm-designer", "title": "VQE 演示"},
                headers=DEMO_HEADERS,
            )
        ).json()
        cid = conversation["id"]

        # -- 第 1 步：发消息 → 202 → SSE delta… → completed(artifacts) --
        posted = await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "请设计一个 VQE 方案"},
            headers=DEMO_HEADERS,
        )
        assert posted.status_code == 202
        receipt = posted.json()
        assert receipt["message_id"].startswith("m-")
        assert receipt["run_id"].startswith("run-")

        # 等运行结束再连流（回放模式，断言确定性的事件全集）
        await asyncio.sleep(0.2)
        frames = await read_sse(
            bundle,
            f"/api/v1/conversations/{cid}/stream?after=0",
            until=lambda fs: any(f.event == "message.completed" for f in fs[1:]),
        )
        names = [f.event for f in frames]
        assert names[0] == "ping"
        deltas = [f for f in frames if f.event == "message.delta"]
        assert len(deltas) >= 2
        # delta 载荷与 seq 单调（契约 §7）
        assert all(f.data["conversation_id"] == cid for f in deltas)
        assert all(f.data["message_id"] == receipt["message_id"] for f in deltas)
        seqs = [f.data["seq"] for f in deltas]
        assert seqs == sorted(seqs)
        # delta… → completed 顺序
        completed = next(f for f in frames if f.event == "message.completed")
        assert names.index("message.delta") < names.index("message.completed")
        artifact_types = [a["type"] for a in completed.data["artifacts"]]
        assert artifact_types == ["circuit", "counts"]

        # -- 第 2/3 步：3 步 DAG 已提交；task.updated 逐步推送 --
        task_frames = [f for f in frames if f.event == "task.updated"]
        assert task_frames, "task.updated 事件缺失"
        assert task_frames[0].data["status"] == "pending"
        task_id = task_frames[0].data["task_id"]
        final_task = await wait_task_status(bundle, task_id)
        # 任务终态后再读一次流：后续 task.updated 帧应推到 succeeded
        followup = await read_sse(
            bundle,
            f"/api/v1/conversations/{cid}/stream?after=0",
            until=lambda fs: any(
                f.event == "task.updated" and f.data["status"] == "succeeded" for f in fs
            ),
        )
        follow_statuses = [f.data["status"] for f in followup if f.event == "task.updated"]
        assert "running" in follow_statuses and follow_statuses[-1] == "succeeded"
        steps = final_task["steps"]
        assert [s["name"] for s in steps] == ["分子积分计算", "VQE 线路执行", "结果后处理"]
        assert [s["kind"] for s in steps] == ["classical", "quantum", "classical"]
        assert steps[1]["depends_on"] == [steps[0]["id"]]  # 链式依赖
        # 容量分配语义：quantum → QPU，classical → CPU（§10 第 3 条）
        assert steps[1]["node_id"] == "qpu-quanta-20q"
        assert {steps[0]["node_id"], steps[2]["node_id"]} == {"cpu-node-0"}

        # -- 第 4 步：hardware.updated 反映过 allocation --
        hw_frames = [f for f in frames if f.event == "hardware.updated"]
        assert hw_frames
        saw_qpu_leased = any(
            any(a["task_id"] == task_id for a in node["allocations"])
            for f in hw_frames
            for node in f.data["nodes"]
        )
        assert saw_qpu_leased, "hardware.updated 未反映 QPU 租约"
        # 任务完成后租约清空
        hardware = (await bundle.http.get("/api/v1/hardware", headers=DEMO_HEADERS)).json()
        assert all(node["allocations"] == [] for node in hardware["nodes"])

        # -- 会话详情含双方消息与 artifacts --
        detail = (
            await bundle.http.get(f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS)
        ).json()
        roles = [m["role"] for m in detail["messages"]]
        assert roles == ["user", "assistant"]
        assistant = detail["messages"][1]
        assert assistant["id"] == receipt["message_id"]
        assert [a["type"] for a in assistant["artifacts"]] == ["circuit", "counts"]

        # -- 任务列表过滤 --
        listed = (
            await bundle.http.get(
                f"/api/v1/tasks?conversation_id={cid}", headers=DEMO_HEADERS
            )
        ).json()
        assert [t["id"] for t in listed] == [task_id]

    async def test_task_not_found_404(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/tasks/t-999", headers=DEMO_HEADERS)
        assert response.status_code == 404


# ---------- SSE 续传与全局流 ----------

class TestSsemantics:
    async def test_after_resume_skips_old_frames(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        cid = conversation["id"]
        await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "断线续传检查"},
            headers=DEMO_HEADERS,
        )
        await asyncio.sleep(0.2)
        first = await read_sse(
            bundle, f"/api/v1/conversations/{cid}/stream?after=0",
            until=lambda fs: any(f.event == "message.completed" for f in fs),
        )
        first_event_seqs = [f.id for f in first if f.event != "ping"]
        assert len(first_event_seqs) >= 2  # echo：1 条 delta + 1 条 completed
        cutoff = first_event_seqs[0]  # 取第 1 个事件作续传游标
        resumed = await read_sse(
            bundle, f"/api/v1/conversations/{cid}/stream?after={cutoff}",
            until=lambda fs: any(f.event == "message.completed" for f in fs),
        )
        resumed_seqs = [f.id for f in resumed if f.event != "ping"]
        assert all(seq > cutoff for seq in resumed_seqs)  # 只补新事件
        assert resumed_seqs[-1] == first_event_seqs[-1]  # 终点一致

    async def test_global_stream_only_task_and_hardware(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations",
                json={"agent_id": "algorithm-designer"},
                headers=DEMO_HEADERS,
            )
        ).json()
        await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "全局流检查"},
            headers=DEMO_HEADERS,
        )
        await asyncio.sleep(0.3)
        frames = await read_sse(
            bundle,
            "/api/v1/events?after=0",
            until=lambda fs: any(
                f.event == "task.updated" and f.data["status"] == "succeeded"
                for f in fs
            ),
        )
        names = {f.event for f in frames}
        assert "message.delta" not in names  # 全局流不含会话级事件
        assert "message.completed" not in names
        assert "task.updated" in names and "hardware.updated" in names


# ---------- 配额与跨租户 ----------

class TestQuotaAndIsolation:
    async def test_message_quota_429_with_retry_after(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
        instance = ClientBundle(make_test_config(max_messages_per_day=2))
        try:
            conversation = (
                await instance.http.post(
                    "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
                )
            ).json()
            for _ in range(2):
                ok = await instance.http.post(
                    f"/api/v1/conversations/{conversation['id']}/messages",
                    json={"content": "hi"}, headers=DEMO_HEADERS,
                )
                assert ok.status_code == 202
            blocked = await instance.http.post(
                f"/api/v1/conversations/{conversation['id']}/messages",
                json={"content": "hi"}, headers=DEMO_HEADERS,
            )
            assert blocked.status_code == 429
            assert int(blocked.headers["Retry-After"]) >= 1
            assert blocked.json()["error"]["code"] == "quota_exceeded"
        finally:
            await instance.app.state.qap.shutdown()
            await instance.http.aclose()

    async def test_cross_tenant_isolation_404(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        cid = conversation["id"]
        # 另一租户：读详情 / 发消息 / 订阅流 一律 404（不泄露存在性）
        assert (
            await bundle.http.get(f"/api/v1/conversations/{cid}", headers=OTHER_HEADERS)
        ).status_code == 404
        assert (
            await bundle.http.post(
                f"/api/v1/conversations/{cid}/messages",
                json={"content": "x"}, headers=OTHER_HEADERS,
            )
        ).status_code == 404
        stream_response = await bundle.http.get(
            f"/api/v1/conversations/{cid}/stream", headers=OTHER_HEADERS
        )
        assert stream_response.status_code == 404
        # 本租户仍可访问（隔离不误伤）
        assert (
            await bundle.http.get(f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS)
        ).status_code == 200

    async def test_tenant_usage_counts_messages(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "count me"}, headers=DEMO_HEADERS,
        )
        await asyncio.sleep(0.1)
        me = (await bundle.http.get("/api/v1/tenants/me", headers=DEMO_HEADERS)).json()
        assert me["usage"]["messages_today"] == 1

    async def test_empty_message_body_422(self, bundle: ClientBundle) -> None:
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "echo"}, headers=DEMO_HEADERS
            )
        ).json()
        response = await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": ""}, headers=DEMO_HEADERS,
        )
        assert response.status_code == 422
