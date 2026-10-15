"""B3 编排 Agent 与 dispatch_agent 测试（契约 §8 v1.1）。

四类场景映射：
- 不变量：dispatch 深度=1（子 Agent 再 dispatch → 工具错误结果，不递归）；
  子 Agent 的 emit_artifact/submit_task 归属当前会话与消息。
- 非法输入拒绝：非 orchestrator 调用 dispatch_agent → 工具错误结果；
  dispatch 到未知 agent → agent_not_found 结构化结果。
- 负样本：子运行 provider 故障 → 结构化 error 回给 orchestrator，主运行收束。
- 可观察行为：agent_id 缺省=orchestrator；orchestrator 测试剧本端到端
  dispatch（产物/任务落在 orchestrator 消息上、回复含收束文本）——
  v1.6：剧本由 tests/scripted_provider.py 测试替身驱动（产品无 mock 渠道）。
"""

from __future__ import annotations

import asyncio

import pytest

from tests.scripted_provider import ScriptedTestProvider

from tests.test_api_integration import (
    DEMO_HEADERS,
    ClientBundle,
    make_test_config,
    read_sse,
)


@pytest.fixture()
async def bundle(monkeypatch: pytest.MonkeyPatch) -> ClientBundle:
    monkeypatch.setenv("QAP_SIM_STEP_SECONDS", "0.1")
    instance = ClientBundle(make_test_config())
    yield instance
    await instance.app.state.qap.shutdown()
    await instance.http.aclose()


def use_scripts(bundle: ClientBundle, scripts: dict) -> None:
    """替换 default 渠道的测试替身剧本（runtime 闭包共享 providers 表）。"""
    bundle.state.providers["default"] = ScriptedTestProvider(scripts)


async def wait_completed(bundle: ClientBundle, cid: str, timeout: float = 6.0) -> list:
    """等主运行收束后回放整条会话流。"""
    await asyncio.sleep(0.3)
    return await read_sse(
        bundle,
        f"/api/v1/conversations/{cid}/stream?after=0",
        until=lambda fs: any(f.event == "message.completed" for f in fs),
        timeout=timeout,
    )


class TestOrchestratorDefault:
    async def test_conversation_defaults_to_orchestrator(self, bundle: ClientBundle) -> None:
        """v1.1：agent_id 缺省 = orchestrator（创建与发消息都如此）。"""
        created = await bundle.http.post(
            "/api/v1/conversations", json={"title": "无 agent"}, headers=DEMO_HEADERS
        )
        assert created.status_code == 201
        assert created.json()["agent_id"] == "orchestrator"
        # agents 清单包含 orchestrator
        agents = (await bundle.http.get("/api/v1/agents", headers=DEMO_HEADERS)).json()
        assert "orchestrator" in {a["id"] for a in agents}

    async def test_orchestrator_script_runs_without_explicit_agent(
        self, bundle: ClientBundle
    ) -> None:
        conversation = (
            await bundle.http.post("/api/v1/conversations", json={}, headers=DEMO_HEADERS)
        ).json()
        posted = await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "帮我设计一个 VQE 方案"},
            headers=DEMO_HEADERS,
        )
        assert posted.status_code == 202
        frames = await wait_completed(bundle, conversation["id"])
        names = [f.event for f in frames]
        assert "message.delta" in names
        assert names[-1] == "message.completed"

    async def test_orchestrator_system_prompt_lists_experts(
        self, bundle: ClientBundle
    ) -> None:
        """编排提示必须描述可用专家（注册表动态合成）。"""
        plugin = bundle.state.plugins.get("orchestrator")
        assert "algorithm-designer" in plugin.system_prompt
        assert "calibration" in plugin.system_prompt
        assert "dispatch_agent" in plugin.system_prompt


class TestDispatchEndToEnd:
    async def test_dispatch_artifacts_and_task_land_on_orchestrator_message(
        self, bundle: ClientBundle
    ) -> None:
        """端到端：orchestrator dispatch algorithm-designer → 产物与任务
        归属 orchestrator 的 assistant 消息与会话（§8 作用域规则）。"""
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations",
                json={"agent_id": "orchestrator", "title": "编排"},
                headers=DEMO_HEADERS,
            )
        ).json()
        cid = conversation["id"]
        posted = await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "全流程 VQE"},
            headers=DEMO_HEADERS,
        )
        receipt = posted.json()
        await wait_completed(bundle, cid)
        detail = (
            await bundle.http.get(f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS)
        ).json()
        assistant = next(
            m for m in detail["messages"] if m["id"] == receipt["message_id"]
        )
        # 子 Agent 的产物（circuit/counts）落在 orchestrator 消息上
        assert [a["type"] for a in assistant["artifacts"]] == ["circuit", "counts"]
        # 子 Agent 提交的任务归属当前会话
        tasks = (
            await bundle.http.get(
                f"/api/v1/tasks?conversation_id={cid}", headers=DEMO_HEADERS
            )
        ).json()
        assert len(tasks) == 1
        # assistant 回复含 orchestrator 收束文本（子回复回流后继续推理）
        assert "专家" in assistant["content"] or "任务" in assistant["content"]

    async def test_dispatch_unknown_agent_structural_error(
        self, bundle: ClientBundle
    ) -> None:
        """负样本：dispatch 到未知 agent → agent_not_found 结构化结果，
        orchestrator 继续推理并收束（不崩平台）。"""
        scripts = {
            "orchestrator": [
                [
                    ("text", "先试试分派。"),
                    ("tool", "dispatch_agent", {"agent_id": "ghost-agent",
                                               "instruction": "做点什么"}),
                ],
                [("text", "该专家不存在，已向用户说明。")],
            ],
        }
        use_scripts(bundle, scripts)
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "orchestrator"},
                headers=DEMO_HEADERS,
            )
        ).json()
        await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q"},
            headers=DEMO_HEADERS,
        )
        await wait_completed(bundle, conversation["id"])
        detail = (
            await bundle.http.get(
                f"/api/v1/conversations/{conversation['id']}", headers=DEMO_HEADERS
            )
        ).json()
        assistant = next(m for m in detail["messages"] if m["role"] == "assistant")
        assert "该专家不存在" in assistant["content"]
        assert assistant["artifacts"] == []


class TestDispatchGating:
    async def test_non_orchestrator_dispatch_denied(self, bundle: ClientBundle) -> None:
        """非 orchestrator 调用 dispatch_agent → 工具错误结果（可自纠错）。"""
        scripts = {
            "calibration": [
                [
                    ("text", "尝试自行分派。"),
                    ("tool", "dispatch_agent", {"agent_id": "echo",
                                               "instruction": "子任务"}),
                ],
                [("text", "分派被拒绝，改为自己处理。")],
            ],
        }
        use_scripts(bundle, scripts)
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "calibration"},
                headers=DEMO_HEADERS,
            )
        ).json()
        await bundle.http.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={"content": "q"},
            headers=DEMO_HEADERS,
        )
        await wait_completed(bundle, conversation["id"])
        # 请求日志证明 echo 从未被分派运行
        agent_ids = [r["agent_id"] for r in bundle.state.providers["default"].request_log]
        assert "echo" not in agent_ids

    async def test_subagent_cannot_dispatch_again(self, bundle: ClientBundle) -> None:
        """深度限制（§8：嵌套深度=1）：子 Agent 再 dispatch → 工具错误结果。"""
        scripts = {
            "orchestrator": [
                [
                    ("text", "分派给校准专家。"),
                    ("tool", "dispatch_agent", {"agent_id": "calibration",
                                               "instruction": "校准 Q0"}),
                ],
                [("text", "校准专家已回复。")],
            ],
            # 子 Agent 的剧本：先试图再分派（应被拒），再正常收束
            "calibration": [
                [
                    ("tool", "dispatch_agent", {"agent_id": "echo",
                                                "instruction": "嵌套子任务"}),
                ],
                [("text", "无法嵌套分派，自行完成校准。")],
            ],
        }
        use_scripts(bundle, scripts)
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "orchestrator"},
                headers=DEMO_HEADERS,
            )
        ).json()
        cid = conversation["id"]
        await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "q"},
            headers=DEMO_HEADERS,
        )
        await wait_completed(bundle, cid)
        # echo 从未被运行（第二次 dispatch 被深度限制拒绝）
        log = bundle.state.providers["default"].request_log
        assert all(r["agent_id"] != "echo" for r in log)
        # calibration 被运行过（orchestrator 的 dispatch 生效）
        assert any(r["agent_id"] == "calibration" for r in log)
        # 主运行正常收束
        detail = (
            await bundle.http.get(f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS)
        ).json()
        assistant = next(m for m in detail["messages"] if m["role"] == "assistant")
        assert "校准专家已回复" in assistant["content"]

    async def test_subagent_provider_failure_structural(self, bundle: ClientBundle) -> None:
        """负样本：子运行 provider 故障 → 结构化 error 回给 orchestrator，
        主运行继续收束（不悬空）。"""
        scripts = {
            "orchestrator": [
                [
                    ("text", "分派给校准专家。"),
                    ("tool", "dispatch_agent", {"agent_id": "calibration",
                                               "instruction": "校准 Q0"}),
                ],
                [("text", "子任务失败，向用户说明。")],
            ],
            "calibration": [[("error", "注入的子运行故障")]],
        }
        use_scripts(bundle, scripts)
        conversation = (
            await bundle.http.post(
                "/api/v1/conversations", json={"agent_id": "orchestrator"},
                headers=DEMO_HEADERS,
            )
        ).json()
        cid = conversation["id"]
        await bundle.http.post(
            f"/api/v1/conversations/{cid}/messages",
            json={"content": "q"},
            headers=DEMO_HEADERS,
        )
        frames = await wait_completed(bundle, cid)
        names = [f.event for f in frames]
        assert "error" in names  # provider 故障走 SSE error（含子运行）
        assert names[-1] == "message.completed"  # 主运行仍收束
        detail = (
            await bundle.http.get(f"/api/v1/conversations/{cid}", headers=DEMO_HEADERS)
        ).json()
        assistant = next(m for m in detail["messages"] if m["role"] == "assistant")
        assert "子任务失败" in assistant["content"]
