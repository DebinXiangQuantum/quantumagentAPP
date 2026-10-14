"""dispatch_agent 步的运行时上下文链接（契约 §4 v1.3 subtask_id 语义）。

机制：agent 步的子运行执行期间，把该 Step 挂进 ``ContextVar``；此期间
子 Agent 经 ``submit_task`` 提交的任务在工具执行侧自动把
``step.subtask_id`` 指向该任务 id（"该步展开的子任务"，嵌套 DAG 下钻）。

**一次一层**：asyncio 的每个 Task 携带创建时刻 contextvars 的副本——
作用域内的写入只影响本执行链；嵌套的 agent 步（本就受 dispatch 深度
限制）进入时以自己的 scope 覆盖、退出时恢复外层，不会误挂。

v1.4 追加 ``running_task_scope``：步骤执行期间把**所属 Task** 挂进另一个
ContextVar——云端 runner 在轮询循环中需要发布 ``task.updated``（排队位置
推进），但 StepRunner 协议签名只携带 Step；经此上下文取回 Task（调度器
``_execute`` 进入时设置，退出恢复，同 dispatch 机制）。
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from qap.domain.models import Step, Task

#: 当前正在执行子运行的 agent 步（None = 会话主运行/非 agent 步执行期）
_current_dispatch_step: ContextVar[Step | None] = ContextVar(
    "qap_current_dispatch_step", default=None
)

#: 当前正在执行步骤所属的 Task（v1.4：云 runner 轮询期推送 task.updated 用）
_current_running_task: ContextVar[Task | None] = ContextVar(
    "qap_current_running_task", default=None
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


@contextmanager
def running_task_scope(task: Task) -> Iterator[Task]:
    """把 ``task`` 标记为"有步骤正在执行"（调度器 _execute 设置）。"""
    token = _current_running_task.set(task)
    try:
        yield task
    finally:
        _current_running_task.reset(token)


def current_running_task() -> Task | None:
    """当前执行中步骤所属 Task（调用方：云 runner 的 task.updated 推送）。"""
    return _current_running_task.get()
