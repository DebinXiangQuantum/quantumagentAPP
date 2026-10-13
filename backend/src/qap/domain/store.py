"""内存态存储：会话 / 消息 / 任务（原型无数据库，接口边界预留持久化）。

租户隔离语义（契约 §5 的 404 而非 403）：跨租户访问已存在资源一律
"not found"——store 的 ``get`` 都带 ``tenant_id`` 过滤，属他租的资源
与不存在的资源同语义返回 ``NotFoundError``。
"""

from __future__ import annotations

from qap.core.errors import NotFoundError
from qap.domain.models import Conversation, Message, Task


class ConversationStore:
    """会话表：按创建序保存，list 支持倒序 limit（最新在前）。"""

    def __init__(self) -> None:
        self._items: dict[str, Conversation] = {}

    def add(self, conversation: Conversation) -> Conversation:
        if conversation.id in self._items:
            raise ValueError(f"duplicate conversation id {conversation.id!r}")
        self._items[conversation.id] = conversation
        return conversation

    def get(self, conversation_id: str, tenant_id: str) -> Conversation:
        conversation = self._items.get(conversation_id)
        if conversation is None or conversation.tenant_id != tenant_id:
            # 跨租户与不存在同语义（契约 §5：不得跨租户访问）
            raise NotFoundError("conversation", conversation_id)
        return conversation

    def list_for_tenant(self, tenant_id: str, limit: int = 50) -> list[Conversation]:
        items = [c for c in self._items.values() if c.tenant_id == tenant_id]
        return list(reversed(items[-limit:]))  # 最新在前


class MessageStore:
    """消息表：按会话分组保序追加。"""

    def __init__(self) -> None:
        self._by_conversation: dict[str, list[Message]] = {}

    def add(self, message: Message) -> Message:
        self._by_conversation.setdefault(message.conversation_id, []).append(message)
        return message

    def list(self, conversation_id: str) -> list[Message]:
        return list(self._by_conversation.get(conversation_id, []))


class TaskStore:
    """任务表：按创建序保存；list 支持 conversation_id 过滤。"""

    def __init__(self) -> None:
        self._items: dict[str, Task] = {}

    def add(self, task: Task) -> Task:
        if task.id in self._items:
            raise ValueError(f"duplicate task id {task.id!r}")
        self._items[task.id] = task
        return task

    def get(self, task_id: str, tenant_id: str) -> Task:
        task = self._items.get(task_id)
        if task is None or task.tenant_id != tenant_id:
            raise NotFoundError("task", task_id)
        return task

    def list_for_tenant(self, tenant_id: str, conversation_id: str | None = None) -> list[Task]:
        tasks = [t for t in self._items.values() if t.tenant_id == tenant_id]
        if conversation_id is not None:
            tasks = [t for t in tasks if t.conversation_id == conversation_id]
        return list(reversed(tasks))
