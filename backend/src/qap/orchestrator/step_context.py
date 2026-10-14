"""dispatch_agent 步的运行时上下文链接（契约 §4 v1.3 subtask_id 语义）。

机制：agent 步的子运行执行期间，把该 Step 挂进 ``ContextVar``；此期间
子 Agent 经 ``submit_task`` 提交的任务在工具执行侧自动把
``step.subtask_id`` 指向该任务 id（"该步展开的子任务"，嵌套 DAG 下钻）。

**一次一层**：asyncio 的每个 Task 携带创建时刻 contextvars 的副本——
作用域内的写入只影响本执行链；嵌套的 agent 步（本就受 dispatch 深度
限制）进入时以自己的 scope 覆盖、退出时恢复外层，不会误挂。
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from qap.domain.models import Step

#: 当前正在执行子运行的 agent 步（None = 会话主运行/非 agent 步执行期）
_current_dispatch_step: ContextVar[Step | None] = ContextVar(
    "qap_current_dispatch_step", default=None
)


@contextmanager
def dispatch_step_scope(step: Step) -> Iterator[Step]:
    """把 ``step`` 标记为"正在执行子运行"（进入/退出成对，token 恢复）。"""
    token = _current_dispatch_step.set(step)
    try:
        yield step
    finally:
        _current_dispatch_step.reset(token)


def current_dispatch_step() -> Step | None:
    """当前 agent 步（调用方：PlatformTools._submit_task 的挂接判定）。"""
    return _current_dispatch_step.get()
