"""UTC 时间戳工具。

契约 §4 的时间字段为 ISO-8601 UTC、Z 后缀。两种精度：
- ``utcnow_iso()``：秒级（``2026-10-13T06:00:00Z``）——created_at 等
  展示型字段沿用；
- ``utcnow_iso_ms()``：毫秒级（``2026-10-13T06:00:00.123Z``）——
  Step.started_at/finished_at 专用：v1.3 不变量 5 要求
  ``duration_ms ≈ finished_at - started_at``（±50ms），秒级精度无法承载
  该容差（工程决策，ISO-8601 语法不变，前端 Date 解析兼容）。
"""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow_iso() -> str:
    """当前 UTC 时间的契约格式字符串（秒级精度，Z 后缀）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utcnow_iso_ms() -> str:
    """当前 UTC 时间的毫秒精度字符串（Z 后缀；见模块 docstring）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
