"""SSE 帧构造与流的公共逻辑（会话流与全局流共用，契约 §7）。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from qap.events.bus import QapEvent, Subscription

#: 每 15 秒发送一次 ping 心跳（契约 §7）
PING_INTERVAL_SECONDS = 15.0


def sse_frame(event: QapEvent) -> str:
    """一条事件的 SSE 帧：``id`` 行（续传游标）+ ``event`` + ``data``。"""
    # ensure_ascii=True：非 ASCII 全部转义为 \uXXXX，保证 data 行纯 ASCII
    # 单行——避免多行/编码问题导致前端 JSON.parse 失败（stream.parse 修复）
    data = json.dumps(event.data, ensure_ascii=True)
    return f"id: {event.seq}\nevent: {event.name}\ndata: {data}\n\n"


def ping_frame() -> str:
    """心跳帧（无 seq——不推进续传游标）。"""
    return "event: ping\ndata: {}\n\n"


async def event_stream(
    bus,
    subscription: Subscription,
    replayed: list[QapEvent],
) -> AsyncIterator[str]:
    """SSE 生成器：先回放历史帧，再跟随实时事件，周期性 ping。

    断线续传语义：调用方已按 ``?after=`` 取得 replayed 列表；本生成器以
    ``last_seq`` 去重（回放与订阅队列之间可能重叠——订阅先建立，回放读的
    是同一缓冲，晚于订阅发布的事件会两处都出现）。

    客户端断开：FastAPI 取消本协程 → ``finally`` 从总线注销订阅，无泄漏。
    """
    last_seq = 0
    try:
        # 立即发一帧 ping：让代理/浏览器立刻 flush 响应头（不影响续传游标）
        yield ping_frame()
        for event in replayed:
            last_seq = max(last_seq, event.seq)
            yield sse_frame(event)
        while True:
            try:
                event = await asyncio.wait_for(
                    subscription.get(), timeout=PING_INTERVAL_SECONDS
                )
            except (asyncio.TimeoutError, TimeoutError):
                yield ping_frame()
                continue
            if event is None:  # 订阅被关闭且队列排空：流正常结束
                return
            if event.seq <= last_seq:  # 回放/实时重叠去重
                continue
            last_seq = event.seq
            yield sse_frame(event)
    finally:
        bus.unsubscribe(subscription)
