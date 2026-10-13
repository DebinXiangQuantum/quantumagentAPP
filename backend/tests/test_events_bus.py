"""S2 事件总线测试：seq 单调、流过滤、回放/续传、缓冲驱逐。

- 不变量：seq 全局单调递增；会话流事件顺序与发布顺序一致。
- 负样本：after 为负数抛 ValueError；缓冲外事件不可续传。
- 可观察行为：会话隔离（两会话互不可见）、全局流只收 task/hardware、
  队列溢出丢最旧。
"""

from __future__ import annotations

import asyncio

import pytest

from qap.events.bus import EVENT_BUFFER_SIZE, EventBus


class TestSequences:
    async def test_seq_monotonic_across_streams(self) -> None:
        bus = EventBus()
        e1 = bus.publish("message.delta", {"delta": "a"}, conversation_id="c-1")
        e2 = bus.publish("task.updated", {"task_id": "t-1"}, conversation_id="c-1")
        e3 = bus.publish("hardware.updated", {"nodes": []})
        assert (e1.seq, e2.seq, e3.seq) == (1, 2, 3)
        assert bus.last_seq == 3

    async def test_message_delta_data_carries_seq(self) -> None:
        bus = EventBus()
        event = bus.publish("message.delta", {"delta": "x"}, conversation_id="c-1")
        assert event.data["seq"] == event.seq
        other = bus.publish("task.updated", {}, conversation_id="c-1")
        assert "seq" not in other.data  # 只有 message.delta 契约带 seq

    async def test_publish_does_not_mutate_caller_data(self) -> None:
        bus = EventBus()
        data = {"delta": "x"}
        bus.publish("message.delta", data, conversation_id="c-1")
        assert data == {"delta": "x"}

    def test_empty_event_name_rejected(self) -> None:
        bus = EventBus()
        with pytest.raises(ValueError):
            bus.publish("", {})


class TestStreamFilters:
    async def test_conversation_stream_isolation(self) -> None:
        """负样本：c-2 的订阅者看不到 c-1 的 message.delta。"""
        bus = EventBus()
        sub1 = bus.subscribe("c-1")
        sub2 = bus.subscribe("c-2")
        bus.publish("message.delta", {"delta": "hello"}, conversation_id="c-1")
        bus.publish("message.delta", {"delta": "other"}, conversation_id="c-2")
        await asyncio.sleep(0)
        got1 = [e.data["delta"] for e in drain(sub1)]
        got2 = [e.data["delta"] for e in drain(sub2)]
        assert got1 == ["hello"]
        assert got2 == ["other"]

    async def test_conversation_stream_receives_global_hardware(self) -> None:
        bus = EventBus()
        sub = bus.subscribe("c-1")
        bus.publish("hardware.updated", {"nodes": []})
        await asyncio.sleep(0)
        assert [e.name for e in drain(sub)] == ["hardware.updated"]

    async def test_global_stream_only_task_and_hardware(self) -> None:
        """全局流（/api/v1/events）只转发 task.updated / hardware.updated。"""
        bus = EventBus()
        sub = bus.subscribe(None)
        bus.publish("message.delta", {"delta": "x"}, conversation_id="c-1")
        bus.publish("message.completed", {}, conversation_id="c-1")
        bus.publish("task.updated", {"task_id": "t-1"}, conversation_id="c-1")
        bus.publish("hardware.updated", {"nodes": []})
        bus.publish("error", {"code": "x", "message": "y"}, conversation_id="c-1")
        await asyncio.sleep(0)
        assert [e.name for e in drain(sub)] == ["task.updated", "hardware.updated"]

    async def test_ordering_preserved_per_subscriber(self) -> None:
        bus = EventBus()
        sub = bus.subscribe("c-1")
        for i in range(5):
            bus.publish("message.delta", {"delta": str(i)}, conversation_id="c-1")
        await asyncio.sleep(0)
        assert [e.data["delta"] for e in drain(sub)] == list("01234")


class TestReplay:
    async def test_replay_after_resumes_from_cursor(self) -> None:
        bus = EventBus()
        for i in range(5):
            bus.publish("message.delta", {"delta": str(i)}, conversation_id="c-1")
        replayed = bus.replay(2, conversation_id="c-1")
        assert [e.seq for e in replayed] == [3, 4, 5]

    async def test_replay_none_means_from_start(self) -> None:
        bus = EventBus()
        bus.publish("hardware.updated", {"nodes": []})
        assert len(bus.replay(None, conversation_id=None)) == 1

    async def test_replay_negative_rejected(self) -> None:
        with pytest.raises(ValueError):
            EventBus().replay(-1, conversation_id="c-1")

    async def test_buffer_eviction_keeps_last_1024(self) -> None:
        """契约：内存缓存最近 1024 条；更早事件不可续传。"""
        bus = EventBus()
        for _ in range(EVENT_BUFFER_SIZE + 50):
            bus.publish("hardware.updated", {"nodes": []})
        replayed = bus.replay(0, conversation_id=None)
        assert len(replayed) == EVENT_BUFFER_SIZE
        assert replayed[0].seq == 51  # 前 50 条被逐出
        assert replayed[-1].seq == EVENT_BUFFER_SIZE + 50

    async def test_replay_respects_stream_filter(self) -> None:
        bus = EventBus()
        bus.publish("message.delta", {}, conversation_id="c-1")
        bus.publish("message.delta", {}, conversation_id="c-2")
        bus.publish("task.updated", {}, conversation_id="c-1")
        assert len(bus.replay(0, conversation_id="c-2")) == 1  # 只有自己的 delta
        assert len(bus.replay(0, conversation_id="c-1")) == 2  # delta + task.updated
        assert len(bus.replay(0, conversation_id=None)) == 1  # 全局只见 task.updated


class TestSubscriberLifecycle:
    async def test_close_stops_delivery(self) -> None:
        bus = EventBus()
        sub = bus.subscribe("c-1")
        bus.publish("message.delta", {}, conversation_id="c-1")
        sub.close()
        bus.publish("message.delta", {}, conversation_id="c-1")
        await asyncio.sleep(0)
        assert len(drain(sub)) == 1
        assert await sub.get() is None  # 关闭且排空后流结束

    async def test_queue_overflow_drops_oldest(self) -> None:
        """慢客户端：队列满时丢最旧并计数（可观察性），不阻塞发布者。"""
        bus = EventBus(subscriber_queue_size=4)
        sub = bus.subscribe("c-1")
        for _ in range(10):
            bus.publish("message.delta", {}, conversation_id="c-1")
        assert sub.dropped == 6
        assert sub.queue.qsize() == 4

    async def test_unsubscribe_idempotent(self) -> None:
        bus = EventBus()
        sub = bus.subscribe("c-1")
        bus.unsubscribe(sub)
        bus.unsubscribe(sub)  # 二次关闭不应抛错


def drain(sub) -> list:
    """同步排空订阅队列（测试辅助）。"""
    items = []
    while not sub.queue.empty():
        items.append(sub.queue.get_nowait())
    return items
