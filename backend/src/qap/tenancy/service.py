"""租户管理：Bearer API Key 鉴权、配额与用量记账（契约 §3/§5）。

职责边界：
- 本服务**只认 Key → 租户**的映射与配额记账，不解析 HTTP（Header 解析在
  ``qap/api/deps.py``）；跨租户资源隔离由 Store 层按 ``tenant_id`` 过滤实现，
  本服务提供 ``ensure_tenant_visible`` 的 404 语义辅助。
- 错误映射：未知/缺失 Key → ``AuthError``（401）；租户禁用 →
  ``AuthError(disabled=True)``（403）；超配额 → ``QuotaError``（429，
  携带 Retry-After 秒数）。
- 计数口径：``max_messages_per_day`` 按自然日（UTC）重置；
  ``max_concurrent_tasks`` 以"已提交未终态"的任务数为准（终态：
  succeeded/failed/cancelled，由调度器回调 ``release_task``）。
- 时间注入：``now_fn`` 参数允许测试注入固定时钟，避免真实等待。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from qap.core.config import TenancyConfig, TenantConfig
from qap.core.errors import AuthError, NotFoundError, QuotaError

#: Retry-After 的保守下界：并发任务配额无法精确预测释放时间，按 1 秒
#: 返回（HTTP 语义允许估计值，客户端应把它当提示而非承诺）。
CONCURRENT_RETRY_AFTER_SECONDS = 1

#: 任务终态集合（与领域模型 TaskStatus 的终态保持一致）
TERMINAL_TASK_STATUSES = frozenset({"succeeded", "failed", "cancelled"})


def _utc_today(now: datetime) -> str:
    """UTC 自然日标识（YYYY-MM-DD），消息配额的重置粒度。"""
    return now.astimezone(timezone.utc).strftime("%Y-%m-%d")


def _seconds_until_utc_midnight(now: datetime) -> int:
    """距下一个 UTC 午夜的秒数（上取整，至少 1）——消息配额的 Retry-After。"""
    now_utc = now.astimezone(timezone.utc)
    tomorrow = (now_utc + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    remaining = (tomorrow - now_utc).total_seconds()
    return max(1, int(remaining) + 1)


@dataclass(frozen=True)
class TenantContext:
    """一次成功鉴权后的租户上下文（请求处理链路的身份凭据）。"""

    tenant: TenantConfig

    @property
    def tenant_id(self) -> str:
        return self.tenant.id


@dataclass
class _TenantRuntime:
    """租户的运行时记账（配置之外的易变状态）。"""

    config: TenantConfig
    enabled: bool = True
    message_count: int = 0
    message_date: str = ""  # 计数所属的 UTC 日期；跨日清零
    active_task_ids: set[str] = field(default_factory=set)


class TenantService:
    """租户注册表 + 鉴权 + 配额（进程内状态，接口边界预留持久化）。"""

    def __init__(
        self,
        config: TenancyConfig,
        *,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self._default_tenant = config.default_tenant
        self._by_id: dict[str, _TenantRuntime] = {}
        self._by_key: dict[str, str] = {}  # api_key -> tenant_id
        for tenant in config.tenants:
            if tenant.api_key in self._by_key:  # 配置层已查重，防御性保留
                raise ValueError(f"duplicate api_key for tenant {tenant.id!r}")
            self._by_id[tenant.id] = _TenantRuntime(config=tenant, enabled=tenant.enabled)
            self._by_key[tenant.api_key] = tenant.id
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    # ---------- 鉴权 ----------

    def authenticate(self, api_key: str | None) -> TenantContext:
        """API Key → 租户上下文。

        :raises AuthError: Key 缺失/未知（401）或租户被禁用（403）。
        """
        if not api_key or not api_key.strip():
            raise AuthError("missing or empty API key")
        tenant_id = self._by_key.get(api_key)
        if tenant_id is None:
            raise AuthError(f"unknown API key ({len(api_key)} chars)")
        runtime = self._by_id[tenant_id]
        if not runtime.enabled:
            raise AuthError(f"tenant {tenant_id!r} is disabled", disabled=True)
        return TenantContext(tenant=runtime.config)

    def tenant_by_id(self, tenant_id: str) -> TenantContext:
        """按租户 id 取上下文（服务内部/测试用；不做 Key 校验）。"""
        runtime = self._by_id.get(tenant_id)
        if runtime is None:
            raise NotFoundError("tenant", tenant_id)
        return TenantContext(tenant=runtime.config)

    def set_enabled(self, tenant_id: str, enabled: bool) -> None:
        """运行时启停租户（403 语义的测试与管理入口）。"""
        runtime = self._by_id.get(tenant_id)
        if runtime is None:
            raise NotFoundError("tenant", tenant_id)
        runtime.enabled = enabled

    # ---------- 配额 ----------

    def check_message_quota(self, tenant_id: str) -> None:
        """校验当日消息配额（不记账；记账在 ``record_message``）。

        :raises QuotaError: 已达 ``max_messages_per_day``，Retry-After 为
            距 UTC 午夜的秒数。
        """
        runtime = self._runtime(tenant_id)
        self._roll_date_if_needed(runtime)
        if runtime.message_count >= runtime.config.max_messages_per_day:
            raise QuotaError(
                f"daily message quota exhausted for tenant {tenant_id!r} "
                f"({runtime.message_count}/{runtime.config.max_messages_per_day})",
                retry_after_seconds=_seconds_until_utc_midnight(self._now_fn()),
            )

    def record_message(self, tenant_id: str) -> None:
        """记一条当日消息（调用前应先 ``check_message_quota`` 通过）。"""
        runtime = self._runtime(tenant_id)
        self._roll_date_if_needed(runtime)
        runtime.message_count += 1

    def register_task(self, tenant_id: str, task_id: str) -> None:
        """登记一个并发任务（提交时调用）。

        :raises QuotaError: 活动任务数已达 ``max_concurrent_tasks``。
        """
        runtime = self._runtime(tenant_id)
        if len(runtime.active_task_ids) >= runtime.config.max_concurrent_tasks:
            raise QuotaError(
                f"concurrent task quota exhausted for tenant {tenant_id!r} "
                f"({len(runtime.active_task_ids)}/{runtime.config.max_concurrent_tasks})",
                retry_after_seconds=CONCURRENT_RETRY_AFTER_SECONDS,
            )
        runtime.active_task_ids.add(task_id)

    def release_task(self, tenant_id: str, task_id: str) -> None:
        """任务进入终态后释放并发额度（幂等）。"""
        runtime = self._runtime(tenant_id)
        runtime.active_task_ids.discard(task_id)

    # ---------- 查询 ----------

    def usage_snapshot(self, tenant_id: str) -> dict:
        """GET /api/v1/tenants/me 的用量/配额视图。"""
        runtime = self._runtime(tenant_id)
        self._roll_date_if_needed(runtime)
        config = runtime.config
        return {
            "id": config.id,
            "name": config.name,
            "enabled": runtime.enabled,
            "usage": {
                "messages_today": runtime.message_count,
                "active_tasks": len(runtime.active_task_ids),
            },
            "quota": {
                "max_concurrent_tasks": config.max_concurrent_tasks,
                "max_messages_per_day": config.max_messages_per_day,
            },
        }

    # ---------- 内部 ----------

    def _runtime(self, tenant_id: str) -> _TenantRuntime:
        runtime = self._by_id.get(tenant_id)
        if runtime is None:
            raise NotFoundError("tenant", tenant_id)
        return runtime

    def _roll_date_if_needed(self, runtime: _TenantRuntime) -> None:
        """跨 UTC 自然日时清零消息计数（惰性结算，无需后台任务）。"""
        today = _utc_today(self._now_fn())
        if runtime.message_date != today:
            runtime.message_date = today
            runtime.message_count = 0
