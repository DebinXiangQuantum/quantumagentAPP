"""领域 id 生成器。

契约 §4 不变量 4：所有领域 id 前缀固定且全局唯一——
`c-` 会话、`m-` 消息、`t-` 任务、`s-` 步骤、`a-` artifact。
进程内用全局计数器 + 已用集合保证唯一；SSE 事件 id（`evt-<seq>`）由
EventBus 自持计数器产生（见 events/bus.py），因为其单调性同时被
`?after=` 断线续传依赖，必须与事件序号严格一致。
`run-` 前缀用于一次 Agent 异步运行（POST messages 返回的 run_id）。
"""

from __future__ import annotations

import itertools
import threading

#: 允许的前缀（含运行/附件前缀）。传入其它前缀视为编程错误，立即抛错。
VALID_PREFIXES = frozenset({"c", "m", "t", "s", "a", "run", "att"})

#: 契约 §4 固定的领域 id 前缀（会话/消息/任务/步骤/artifact）。
#: ``att-``（附件，v1.3）不在不变量 4 的五前缀清单内——附件经
#: AttachmentMeta 挂在 Message 上而非独立领域对象树。
DOMAIN_PREFIXES = frozenset({"c", "m", "t", "s", "a"})


class IdCollisionError(RuntimeError):
    """同一前缀下生成了重复 id——理论上不可能，出现即实现缺陷，fail-fast。"""


class IdGenerator:
    """线程安全的单调 id 生成器。

    设计假设：原型为单进程内存态；跨进程唯一性以接口边界预留（未来可加
    进程随机段）。`next(prefix)` 返回形如 ``c-1``、``c-2`` 的递增 id。
    """

    def __init__(self) -> None:
        self._counters: dict[str, itertools.count] = {}
        self._used: set[str] = set()
        self._lock = threading.Lock()

    def next(self, prefix: str) -> str:
        """生成下一个带前缀 id。

        :param prefix: 必须在 :data:`VALID_PREFIXES` 内。
        :raises ValueError: 前缀非法（未知前缀说明调用方写错了契约）。
        :raises IdCollisionError: 生成了重复 id（实现缺陷保护）。
        """
        if prefix not in VALID_PREFIXES:
            raise ValueError(
                f"unknown id prefix {prefix!r}; valid prefixes: {sorted(VALID_PREFIXES)}"
            )
        with self._lock:
            counter = self._counters.setdefault(prefix, itertools.count(1))
            value = f"{prefix}-{next(counter)}"
            if value in self._used:  # pragma: no cover - 防御性断言
                raise IdCollisionError(f"duplicate id generated: {value}")
            self._used.add(value)
            return value
