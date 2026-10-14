"""SSE 事件总线：发布/订阅 + 内存回放缓存（契约 §7）。

- 事件全局单调 ``seq``（从 1 开始），SSE 帧的 ``id:`` 即 seq，
  客户端断线后用 ``?after=<seq>`` 续传。
- 内存缓存**最近 1024 条**（契约原型的回放窗口）；更早的事件不可续传，
  客户端应做好全量刷新的降级准备。
- 两类订阅（与 REST 端点一一对应）：
  * 会话流（``conversation_id`` 非 None）：该会话的 message.* / task.updated /
    error，外加全局 hardware.updated；
  * 全局流（``conversation_id=None``）：仅 task.updated / hardware.updated。
- ``message.delta`` / ``message.reasoning`` 的 data 按契约带 ``seq``
  字段——发布方不需要自己填，总线在此处注入，保证与帧 id 严格一致。
"""

from __future__ import annotations

import asyncio
import itertools
from collections import deque
from dataclasses import dataclass, field
from typing import Any

#: 契约 §7：内存回放缓存条数上限
EVENT_BUFFER_SIZE = 1024
#: 全局 SSE（GET /api/v1/events）转发的事件名（契约 §5：task/hardware 事件）
GLOBAL_STREAM_NAMES = frozenset({"task.updated", "hardware.updated"})
#: 契约 §7：data 载荷需要注入 seq 的事件（增量流，供客户端排序/续传）。
#: v1.4 增 `agent.activity`（dispatch 子运行的实时外显流，载荷按 §7 带 seq）。
SEQ_CARRYING_EVENT_NAMES = frozenset(
    {"message.delta", "message.reasoning", "agent.activity"}
)
#: 订阅者队列上限：超过则丢弃最旧事件（SSE 客户端可用 ?after= 补齐）
SUBSCRIBER_QUEUE_SIZE = 256


@dataclass(frozen=True)
class QapEvent:
    """一条已发布事件：``seq`` 全局单调，``conversation_id`` 为 None 表示
    与具体会话无关（如 hardware.updated）。"""

    seq: int
    name: str
    data: dict[str, Any]
    conversation_id: str | None = None

    @property
    def id(self) -> str:
        """SSE 帧 id（同时是 ?after= 游标）。"""
        return f"evt-{self.seq}"

    def matches(self, conversation_id: str | None) -> bool:
        """事件是否应进入某条流（会话流或全局流，规则见模块 docstring）。"""
        if conversation_id is None:
            return self.name in GLOBAL_STREAM_NAMES
        return self.conversation_id == conversation_id or self.name == "hardware.updated"


class Subscription:
    """一个活跃订阅：内部 asyncio.Queue 供 SSE 生成器消费。

    队列有界（防慢客户端拖垮内存）；满时丢最旧事件并保留
    ``queue_overflow`` 标记，SSE 层可在下一帧前提示客户端续传。
    """

    def __init__(self, conversation_id: str | None, queue_size: int = SUBSCRIBER_QUEUE_SIZE) -> None:
        if queue_size < 1:
            raise ValueError("queue_size must be >= 1")
        self.conversation_id = conversation_id
        self.queue: asyncio.Queue[QapEvent] = asyncio.Queue(maxsize=queue_size)
        self.closed = False
        self.dropped = 0  # 因队列满而被丢弃的事件数（可观察性）

    def close(self) -> None:
        """幂等关闭；关闭后不再接收新事件。"""
        self.closed = True

    async def get(self) -> QapEvent | None:
        """取下一条事件；订阅关闭且队列排空后返回 None（流结束信号）。"""
        while True:
            try:
                return self.queue.get_nowait()
            except asyncio.QueueEmpty:
                if self.closed:
                    return None
                await asyncio.sleep(0.01)  # 轮询间隔：SSE 场景下足够低延迟


@dataclass
class _BusState:
    """EventBus 的可变状态（集中放置便于测试注入小缓冲）。"""

    seq_counter: itertools.count = field(default_factory=lambda: itertools.count(1))
    buffer: deque[QapEvent] = field(default_factory=lambda: deque(maxlen=EVENT_BUFFER_SIZE))


class EventBus:
    """进程内事件总线（asyncio 单线程假设，无锁）。"""

    def __init__(
        self,
        buffer_size: int = EVENT_BUFFER_SIZE,
        subscriber_queue_size: int = SUBSCRIBER_QUEUE_SIZE,
    ) -> None:
        if buffer_size < 1:
            raise ValueError("buffer_size must be >= 1")
        self._state = _BusState()
        self._state.buffer = deque(maxlen=buffer_size)
        self._subscriber_queue_size = subscriber_queue_size
        self._subscriptions: set[Subscription] = set()

    @property
    def last_seq(self) -> int:
        """最近一次发布的 seq（未发布过为 0）。"""
        return self._state.buffer[-1].seq if self._state.buffer else 0

    def publish(
        self, name: str, data: dict[str, Any], *, conversation_id: str | None = None
    ) -> QapEvent:
        """发布事件：写入回放缓冲并投递给所有匹配订阅。

        :param name: SSE 事件名（契约 §7 表格中的任一名字）。
        :param data: 事件载荷；增量流事件（message.delta / message.reasoning）
            会在此注入 ``seq``。
        :param conversation_id: 事件所属会话；None 表示全局事件。
        """
        if not name or not isinstance(name, str):
            raise ValueError("event name must be a non-empty string")
        seq = next(self._state.seq_counter)
        payload = dict(data)  # 不篡改调用方字典
        if name in SEQ_CARRYING_EVENT_NAMES:
            payload["seq"] = seq  # 契约字段：与 SSE 帧 id 一致
        event = QapEvent(seq=seq, name=name, data=payload, conversation_id=conversation_id)
        self._state.buffer.append(event)
        for sub in list(self._subscriptions):
            if sub.closed or not event.matches(sub.conversation_id):
                continue
            if sub.queue.full():  # 丢最旧，留标记（慢客户端可 ?after= 续传）
                sub.queue.get_nowait()
                sub.dropped += 1
            sub.queue.put_nowait(event)
        return event

    def subscribe(self, conversation_id: str | None = None) -> Subscription:
        """创建订阅（会话流传 cid，全局流传 None）。

        注意：订阅**不**回放历史——需要续传的客户端由 API 层先调
        :meth:`replay` 再订阅（两条调用之间的事件由缓冲一致性兜底：
        replay 基于 buffer，subscribe 之后的投递基于内存队列，二者
        在单线程事件循环内原子衔接）。
        """
        sub = Subscription(conversation_id, queue_size=self._subscriber_queue_size)
        self._subscriptions.add(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        """移除订阅（幂等）。"""
        sub.close()
        self._subscriptions.discard(sub)

    def replay(self, after_seq: int | None, *, conversation_id: str | None) -> list[QapEvent]:
        """返回 seq > after_seq 且匹配该流的所有缓存事件（按 seq 升序）。

        :param after_seq: 客户端最后收到的 seq；None/0 表示从头。
        """
        floor = 0 if after_seq is None else int(after_seq)
        if floor < 0:
            raise ValueError("after_seq must be >= 0")
        return [
            event
            for event in self._state.buffer
            if event.seq > floor and event.matches(conversation_id)
        ]
