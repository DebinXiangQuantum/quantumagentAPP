"""S2 领域模型测试：契约 §4 的形状与不变量。

- 不变量：id 前缀形状、utilization ∈ [0,1] 且有限。
- 非法输入拒绝：NaN/±inf/越界利用率、错误 id 前缀、未知字段。
- 可观察行为：序列化键与契约字段一一对应。
"""

from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from qap.core.errors import ValidationFailed
from qap.domain.models import Artifact, Conversation, HardwareNode, Message, Step, Task


def base_node_kwargs(**overrides) -> dict:
    base = {
        "id": "gpu-a800-0",
        "kind": "gpu",
        "name": "A800 #0",
        "model": "NVIDIA A800 80GB",
        "capacity": 1,
    }
    base.update(overrides)
    return base


class TestHardwareNode:
    def test_valid_node_serializes_contract_fields(self) -> None:
        node = HardwareNode(**base_node_kwargs(), utilization=0.37, status="online")
        payload = node.model_dump()
        # 契约 §4 HardwareNode 字段逐一存在（多出的 allocations 是契约内字段）
        assert set(payload) == {
            "id", "kind", "name", "model", "status", "utilization", "capacity", "allocations",
        }
        assert payload["utilization"] == 0.37

    @pytest.mark.parametrize("bad", [-0.01, 1.01, float("nan"), float("inf"), float("-inf")])
    def test_utilization_bounds_and_finiteness(self, bad: float) -> None:
        """不变量 3：utilization 必须有限且 ∈ [0,1]（NaN 比较特性需显式拒绝）。"""
        with pytest.raises(ValidationError):
            HardwareNode(**base_node_kwargs(utilization=bad))

    @pytest.mark.parametrize("ok", [0.0, 1.0, 0.5])
    def test_utilization_accepts_closed_interval(self, ok: float) -> None:
        assert HardwareNode(**base_node_kwargs(utilization=ok)).utilization == ok

    def test_capacity_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            HardwareNode(**base_node_kwargs(capacity=0))

    def test_unknown_kind_rejected(self) -> None:
        with pytest.raises(ValidationError):
            HardwareNode(**base_node_kwargs(kind="tpu"))

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            HardwareNode(**base_node_kwargs(), extra_field=1)


class TestIdShapes:
    def test_conversation_requires_c_prefix(self) -> None:
        kwargs = dict(agent_id="echo", tenant_id="demo", created_at="2026-10-13T06:00:00Z")
        assert Conversation(id="c-1", **kwargs)
        with pytest.raises(ValidationError):
            Conversation(id="x-1", **kwargs)

    def test_message_requires_m_prefix(self) -> None:
        kwargs = dict(
            conversation_id="c-1", role="user", content="hi", agent_id="echo",
            created_at="2026-10-13T06:00:00Z",
        )
        assert Message(id="m-1", **kwargs)
        with pytest.raises(ValidationError):
            Message(id="c-1", **kwargs)

    def test_task_and_step_prefixes(self) -> None:
        task = Task(
            id="t-1", conversation_id="c-1", tenant_id="demo", name="VQE",
            steps=[Step(id="s-0", name="积分", kind="classical")],
            created_at="2026-10-13T06:00:00Z",
        )
        assert task.steps[0].status == "pending"
        with pytest.raises(ValidationError):
            Task(id="m-1", conversation_id="c-1", tenant_id="demo", name="x",
                 created_at="2026-10-13T06:00:00Z")
        with pytest.raises(ValidationError):
            Step(id="t-0", name="x", kind="quantum")

    def test_step_rejects_unknown_kind_and_status(self) -> None:
        with pytest.raises(ValidationError):
            Step(id="s-0", name="x", kind="hybrid")
        with pytest.raises(ValidationError):
            Step(id="s-0", name="x", kind="agent", status="paused")


class TestArtifactEnvelope:
    def test_known_type_payload_validated_on_construction(self) -> None:
        good_counts = {"shots": 8, "qubits": 1, "counts": {"0": 4, "1": 4}}
        art = Artifact(id="a-1", type="counts", title="结果", payload=good_counts)
        assert art.payload["shots"] == 8

    def test_known_type_bad_payload_rejected_on_construction(self) -> None:
        bad_counts = {"shots": 8, "qubits": 1, "counts": {"0": 4, "1": 5}}  # 和 != shots
        with pytest.raises(ValidationFailed, match="sum"):
            Artifact(id="a-1", type="counts", title="结果", payload=bad_counts)

    def test_unknown_type_passes_through_for_graceful_degradation(self) -> None:
        art = Artifact(id="a-2", type="future-type", payload={"anything": [1, 2]})
        assert art.payload == {"anything": [1, 2]}

    def test_artifact_requires_a_prefix(self) -> None:
        with pytest.raises(ValidationError):
            Artifact(id="x-1", type="counts", payload={"shots": 1, "qubits": 1, "counts": {"0": 1}})
