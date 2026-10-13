"""UTC 时间戳工具。

契约 §4 的时间字段统一为 ISO-8601 UTC、秒级精度、Z 后缀
（如 ``2026-10-13T06:00:00Z``）。集中在此格式化，避免各模块各自为政。
"""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow_iso() -> str:
    """当前 UTC 时间的契约格式字符串（秒级精度，Z 后缀）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
