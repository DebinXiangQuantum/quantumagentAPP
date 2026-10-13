"""SSE 行解析小工具（openai/anthropic provider 共用）。

按 MDN SSE 规范：每个事件由若干 ``event:``/``data:`` 行 + 空行组成；
两个 provider 都只需要 ``data:`` 载荷（anthropic 还需要 event 名）。
注释行（``:`` 开头）与心跳按规范忽略。
"""

from __future__ import annotations

from collections.abc import AsyncIterator


async def iter_sse_events(
    lines: AsyncIterator[str],
) -> AsyncIterator[tuple[str | None, str]]:
    """把 ``response.aiter_lines()`` 的行流折叠成 ``(event_name, data)``。

    :param lines: httpx 的异步行迭代器。
    :yields: 每遇到一个 ``data:`` 行产出一对；event 名为其前最近的
        ``event:`` 值（未出现则为 None——openai wire format 不用 event 行）。
    """
    current_event: str | None = None
    async for line in lines:
        if line.startswith(":"):  # 注释/心跳
            continue
        if line.startswith("event:"):
            current_event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            yield current_event, line[len("data:"):].strip()
            current_event = None
