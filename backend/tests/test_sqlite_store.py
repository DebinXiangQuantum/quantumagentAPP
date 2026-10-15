"""SQLite 持久化层测试（v1.9）——重启不丢、租户隔离、接口兼容。

不变量：重启（新建连接）后会话/消息/任务/附件全部可读；消息保序。
负样本：跨租户 get → NotFound；重复 id → ValueError。
可观察行为：list_for_tenant 最新在前；附件字节无损回读。
"""

from __future__ import annotations

import pytest

from qap.core.errors import NotFoundError
from qap.domain.db import build_sqlite_stores
from qap.domain.models import Conversation, Message, Task


def make_stores(tmp_path):
    return build_sqlite_stores(tmp_path / "test.db")


def make_conversation(cid="c-1", tenant="demo"):
    return Conversation(
        id=cid, title="测试", agent_id="orchestrator",
        tenant_id=tenant, created_at="2026-10-15T00:00:00Z",
    )


def make_message(mid, cid, role="user", content="hello"):
    return Message(
        id=mid, conversation_id=cid, role=role, content=content,
        agent_id="orchestrator", created_at="2026-10-15T00:00:01Z",
    )


def make_task(tid, cid, tenant="demo"):
    return Task(
        id=tid, conversation_id=cid, tenant_id=tenant, name="test",
        status="pending", steps=[], created_at="2026-10-15T00:00:02Z",
    )


class TestPersistence:
    def test_conversation_survives_restart(self, tmp_path):
        stores = make_stores(tmp_path)
        conv = make_conversation()
        stores["conversations"].add(conv)
        # 模拟重启：新建连接（同一 db 文件）
        stores2 = build_sqlite_stores(tmp_path / "test.db")
        loaded = stores2["conversations"].get("c-1", "demo")
        assert loaded.title == "测试"

    def test_messages_ordered_and_survive(self, tmp_path):
        stores = make_stores(tmp_path)
        conv = make_conversation()
        stores["conversations"].add(conv)
        for i in range(5):
            stores["messages"].add(make_message(f"m-{i}", "c-1", content=f"msg-{i}"))
        stores2 = build_sqlite_stores(tmp_path / "test.db")
        msgs = stores2["messages"].list("c-1")
        assert [m.content for m in msgs] == [f"msg-{i}" for i in range(5)]

    def test_message_update_in_place(self, tmp_path):
        stores = make_stores(tmp_path)
        stores["conversations"].add(make_conversation())
        m = make_message("m-1", "c-1", content="original")
        stores["messages"].add(m)
        m.content = "updated by agent"
        stores["messages"].update(m)
        stores2 = build_sqlite_stores(tmp_path / "test.db")
        assert stores2["messages"].list("c-1")[0].content == "updated by agent"

    def test_task_survives_and_updates(self, tmp_path):
        stores = make_stores(tmp_path)
        stores["conversations"].add(make_conversation())
        task = make_task("t-1", "c-1")
        stores["tasks"].add(task)
        task.status = "succeeded"
        stores["tasks"].update(task)
        stores2 = build_sqlite_stores(tmp_path / "test.db")
        assert stores2["tasks"].get("t-1", "demo").status == "succeeded"

    def test_attachment_bytes_roundtrip(self, tmp_path):
        from qap.domain.attachments import AttachmentMeta, AttachmentRecord

        stores = make_stores(tmp_path)
        stores["conversations"].add(make_conversation())
        data = b"\x89PNG fake image bytes \x00\x01"
        record = AttachmentRecord(
            id="att-1", conversation_id="c-1", tenant_id="demo",
            name="img.png", mime="image/png", size=len(data),
            kind="image", data=data,
        )
        stores["attachments"].add(record)
        stores2 = build_sqlite_stores(tmp_path / "test.db")
        loaded = stores2["attachments"].get("att-1", "demo")
        assert loaded.data == data
        assert loaded.mime == "image/png"


class TestTenantIsolation:
    def test_cross_tenant_not_found(self, tmp_path):
        stores = make_stores(tmp_path)
        stores["conversations"].add(make_conversation(tenant="demo"))
        with pytest.raises(NotFoundError):
            stores["conversations"].get("c-1", "other")

    def test_list_filters_tenant(self, tmp_path):
        stores = make_stores(tmp_path)
        stores["conversations"].add(make_conversation("c-1", "demo"))
        stores["conversations"].add(make_conversation("c-2", "other"))
        assert len(stores["conversations"].list_for_tenant("demo")) == 1


class TestDuplicateRejection:
    def test_duplicate_conversation(self, tmp_path):
        stores = make_stores(tmp_path)
        stores["conversations"].add(make_conversation())
        with pytest.raises(ValueError):
            stores["conversations"].add(make_conversation())
