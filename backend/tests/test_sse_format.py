"""S8 补充：SSE 帧格式与心跳语义的单元级断言（契约 §7）。"""

from __future__ import annotations

import asyncio
import json

from qap.api.sse import PING_INTERVAL_SECONDS, event_stream, ping_frame, sse_frame
from qap.events.bus import EventBus, QapEvent


class TestFrameFormat:
    def test_sse_frame_shape(self) -> None:
        """帧 = id 行（seq 游标）+ event 行 + data 行 + 空行。"""
        event = QapEvent(seq=7, name="message.delta", data={"delta": "hi", "seq": 7})
        frame = sse_frame(event)
        assert frame == 'id: 7\nevent: message.delta\ndata: {"delta": "hi", "seq": 7}\n\n'

    def test_ping_frame_has_no_id(self) -> None:
        """心跳不推进续传游标（无 id 行）。"""
        assert ping_frame() == "event: ping\ndata: {}\n\n"

    def test_ping_interval_is_contract_15s(self) -> None:
        assert PING_INTERVAL_SECONDS == 15.0


class TestEventStream:
    async def test_stream_yields_ping_then_frames(self) -> None:
        """连接即发 ping；随后按序回放；实时事件 seq 去重。"""
        bus = EventBus()
        bus.publish("message.delta", {"delta": "a"}, conversation_id="c-1")
        bus.publish("message.completed", {"x": 1}, conversation_id="c-1")
        subscription = bus.subscribe("c-1")
        replayed = bus.replay(0, conversation_id="c-1")
        # 模拟订阅后又有发布（回放/实时重叠，须去重）
        duplicated = bus.publish("message.delta", {"delta": "b"}, conversation_id="c-1")
        subscription.queue.put_nowait(duplicated)

        frames: list[str] = []
        stream = event_stream(bus, subscription, replayed)

        async def consume(count: int) -> None:
            async for frame in stream:
                frames.append(frame)
                if len(frames) >= count:
                    return

        await asyncio.wait_for(consume(4), timeout=2)  # ping + 3 事件（重复帧被去重）
        await stream.aclose()  # 模拟客户端断开：Starlette 会关闭生成器
        assert frames[0] == ping_frame()
        names = [line.split(": ", 1)[1] for f in frames[1:] for line in f.splitlines() if line.startswith("event:")]
        assert names == ["message.delta", "message.completed", "message.delta"]
        # 订阅已注销（流中止后不泄漏）
        assert subscription.closed and subscription not in bus._subscriptions

    async def test_stream_parses_back_to_json(self) -> None:
        """帧可无损解析回事件数据（前端 data 解析路径等价）。"""
        bus = EventBus()
        event = bus.publish("task.updated", {"task_id": "t-1", "status": "pending"}, conversation_id="c-1")
        subscription = bus.subscribe("c-1")
        stream = event_stream(bus, subscription, bus.replay(0, conversation_id="c-1"))
        iterator = stream.__aiter__()
        await iterator.__anext__()  # ping
        frame = await iterator.__anext__()
        data_line = next(line for line in frame.splitlines() if line.startswith("data:"))
        assert json.loads(data_line[5:])["task_id"] == "t-1"
        bus.unsubscribe(subscription)
