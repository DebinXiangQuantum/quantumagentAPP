"""SQLite 持久化层（v1.9）——会话/消息/任务/附件落库，重启不丢。

设计原则：
- **零依赖**：Python 标准库 sqlite3 + json——不引入 SQLAlchemy 等 ORM
  （与平台最小依赖面原则一致，见 docs/ARCHITECTURE.md §2 工程选择）；
- **接口不变**：持久化 Store 的方法签名与内存版完全一致（duck-typing），
  组装根按 config.storage.backend 切换（"sqlite" | "memory"）；
- **行级 JSON**：Pydantic 模型整体序列化为 JSON 列（原型的序列化形状即
  存储形状——契约 §4 的 JSON 就是数据库行）；附件字节存 BLOB；
- **WAL 模式**：并发读写友好（SSE 轮询 + API 写入不互锁）。

表结构：
- conversations(id TEXT PK, tenant_id TEXT, created_at TEXT, data TEXT)
- messages(id TEXT PK, conversation_id TEXT, seq INTEGER, data TEXT)
- tasks(id TEXT PK, tenant_id TEXT, data TEXT)
- attachments(id TEXT PK, tenant_id TEXT, data TEXT, blob BLOB)

seq 列：消息按 (conversation_id, seq) 保序——插入时取当前会话计数器。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from qap.core.errors import NotFoundError
from qap.domain.artifacts import ValidationFailed  # AttachmentStore 复用


#: 附件大小上限（与路由层一致，双闸）
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant ON conversations(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_tenant ON tasks(tenant_id);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    data TEXT NOT NULL,
    blob BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_tenant ON attachments(tenant_id);
"""


def _connect(db_path: str | Path) -> sqlite3.Connection:
    """打开 SQLite 连接（WAL + 外键；check_same_thread=False——锁由调用方管）。"""
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class SqliteConversationStore:
    """会话表（SQLite）——方法签名与内存版 ConversationStore 一致。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()
        self._conn.executescript(_SCHEMA)

    def add(self, conversation) -> None:
        """插入会话（幂等——同 id 同租户已存在则静默返回，v1.11 修复重启 500）。"""
        data = conversation.model_dump_json()
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO conversations VALUES (?,?,?,?)",
                    (conversation.id, conversation.tenant_id,
                     conversation.created_at, data),
                )
                self._conn.commit()
            except sqlite3.IntegrityError:
                # v1.11: 重启后 IdGenerator 重新分配同 ID（c-1 等）撞上
                # SQLite 已有行 → 幂等返回（同租户同 id 不再 500）
                row = self._conn.execute(
                    "SELECT tenant_id FROM conversations WHERE id=?",
                    (conversation.id,),
                ).fetchone()
                if row is not None and row[0] == conversation.tenant_id:
                    return
                raise ValueError(f"duplicate conversation id {conversation.id!r}")

    def get(self, conversation_id: str, tenant_id: str):
        from qap.domain.models import Conversation

        row = self._conn.execute(
            "SELECT data FROM conversations WHERE id=? AND tenant_id=?",
            (conversation_id, tenant_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("conversation", conversation_id)
        return Conversation.model_validate_json(row[0])

    def list_for_tenant(self, tenant_id: str, limit: int = 50) -> list:
        from qap.domain.models import Conversation

        rows = self._conn.execute(
            "SELECT data FROM conversations WHERE tenant_id=? "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (tenant_id, limit),
        ).fetchall()
        return [Conversation.model_validate_json(r[0]) for r in rows]

    def update(self, conversation) -> None:
        """更新会话（标题等字段变更；不存在时静默——调用方保证已存在）。"""
        with self._lock:
            self._conn.execute(
                "UPDATE conversations SET data=? WHERE id=?",
                (conversation.model_dump_json(), conversation.id),
            )
            self._conn.commit()


class SqliteMessageStore:
    """消息表（SQLite）——按 (conversation_id, seq) 保序。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()
        self._conn.executescript(_SCHEMA)

    def _next_seq(self, conversation_id: str) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE conversation_id=?",
            (conversation_id,),
        ).fetchone()
        return int(row[0])

    def add(self, message) -> None:
        """追加消息（幂等——同 id 已存在则返回，v1.11 修复重启 500）。"""
        seq = self._next_seq(message.conversation_id)
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO messages VALUES (?,?,?,?)",
                    (message.id, message.conversation_id, seq,
                     message.model_dump_json()),
                )
                self._conn.commit()
            except sqlite3.IntegrityError:
                row = self._conn.execute(
                    "SELECT 1 FROM messages WHERE id=?", (message.id,),
                ).fetchone()
                if row is not None:
                    return
                raise ValueError(f"duplicate message id {message.id!r}")

    def update(self, message) -> None:
        """就地更新消息（Agent 运行中填充 content/reasoning/artifacts）。"""
        with self._lock:
            self._conn.execute(
                "UPDATE messages SET data=? WHERE id=?",
                (message.model_dump_json(), message.id),
            )
            self._conn.commit()

    def list(self, conversation_id: str) -> list:
        from qap.domain.models import Message

        rows = self._conn.execute(
            "SELECT data FROM messages WHERE conversation_id=? ORDER BY seq",
            (conversation_id,),
        ).fetchall()
        return [Message.model_validate_json(r[0]) for r in rows]


class SqliteTaskStore:
    """任务表（SQLite）。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()
        self._conn.executescript(_SCHEMA)

    def add(self, task) -> None:
        """插入任务（幂等——同 id 已存在则返回，v1.11 修复重启 500）。"""
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO tasks VALUES (?,?,?)",
                    (task.id, task.tenant_id, task.model_dump_json()),
                )
                self._conn.commit()
            except sqlite3.IntegrityError:
                row = self._conn.execute(
                    "SELECT 1 FROM tasks WHERE id=?", (task.id,),
                ).fetchone()
                if row is not None:
                    return
                raise ValueError(f"duplicate task id {task.id!r}")

    def get(self, task_id: str, tenant_id: str):
        from qap.domain.models import Task

        row = self._conn.execute(
            "SELECT data FROM tasks WHERE id=? AND tenant_id=?",
            (task_id, tenant_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("task", task_id)
        return Task.model_validate_json(row[0])

    def update(self, task) -> None:
        """就地更新任务（调度器推进 step 状态时高频调用）。"""
        with self._lock:
            self._conn.execute(
                "UPDATE tasks SET data=? WHERE id=?",
                (task.model_dump_json(), task.id),
            )
            self._conn.commit()

    def list_for_tenant(self, tenant_id: str,
                        conversation_id: str | None = None) -> list:
        from qap.domain.models import Task

        if conversation_id is not None:
            rows = self._conn.execute(
                "SELECT data FROM tasks WHERE tenant_id=? AND id IN "
                "(SELECT json_extract(data, '$.id') FROM tasks "
                "WHERE json_extract(data, '$.conversation_id')=?)",
                (tenant_id, conversation_id),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT data FROM tasks WHERE tenant_id=?", (tenant_id,)
            ).fetchall()
        return [Task.model_validate_json(r[0]) for r in rows]


class SqliteAttachmentStore:
    """附件表（SQLite）——元数据 JSON + 原字节 BLOB。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()
        self._conn.executescript(_SCHEMA)

    def add(self, record) -> None:
        """存储附件（元数据 JSON 含归属字段 conversation_id/tenant_id——
        AttachmentMeta 只是对外视图，不含归属）。"""
        full = {
            "id": record.id,
            "conversation_id": record.conversation_id,
            "tenant_id": record.tenant_id,
            "name": record.name,
            "mime": record.mime,
            "size": record.size,
            "kind": record.kind,
        }
        meta_json = json.dumps(full, ensure_ascii=False)
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO attachments VALUES (?,?,?,?)",
                    (record.id, record.tenant_id, meta_json, record.data),
                )
                self._conn.commit()
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"duplicate attachment id {record.id!r}") from exc

    def get(self, attachment_id: str, tenant_id: str):
        row = self._conn.execute(
            "SELECT data, blob FROM attachments WHERE id=? AND tenant_id=?",
            (attachment_id, tenant_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("attachment", attachment_id)
        meta = json.loads(row[0])
        from qap.domain.attachments import AttachmentRecord

        return AttachmentRecord(
            id=meta["id"],
            conversation_id=meta["conversation_id"],
            tenant_id=meta["tenant_id"],
            name=meta["name"], mime=meta["mime"],
            size=meta["size"], kind=meta["kind"], data=row[1],
        )

    def get_for_conversation(self, attachment_id: str,
                             conversation_id: str, tenant_id: str):
        record = self.get(attachment_id, tenant_id)
        if record.conversation_id != conversation_id:
            raise ValidationFailed(
                f"attachment {attachment_id!r} does not belong to this conversation"
            )
        return record


def build_sqlite_stores(db_path: str | Path) -> dict[str, Any]:
    """构造全部 SQLite Store（单连接共享，WAL 模式）。

    :param db_path: 数据库文件路径（自动创建父目录）。
    :return: {"conversations": …, "messages": …, "tasks": …, "attachments": …,
              "connection": conn}——组装根按 key 取用。
    """
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect(path)
    return {
        "conversations": SqliteConversationStore(conn),
        "messages": SqliteMessageStore(conn),
        "tasks": SqliteTaskStore(conn),
        "attachments": SqliteAttachmentStore(conn),
        "connection": conn,
    }
