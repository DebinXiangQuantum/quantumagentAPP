"""S3 租户服务测试：鉴权、401/403、配额 429、用量记账与跨日重置。

- 非法输入拒绝：缺失/空白/未知 Key。
- 负样本：租户禁用（403）、消息超配额（QuotaError+Retry-After）、
  并发任务超配额。
- 可观察行为：跨 UTC 日计数清零；释放任务后额度恢复。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from qap.core.config import TenancyConfig, TenantConfig
from qap.core.errors import AuthError, NotFoundError, QuotaError
from qap.tenancy.service import TenantService


def make_config(**tenant_overrides) -> TenancyConfig:
    base = dict(
        id="demo",
        name="Demo 租户",
        api_key="demo-key",
        max_concurrent_tasks=2,
        max_messages_per_day=3,
    )
    base.update(tenant_overrides)
    return TenancyConfig(default_tenant="demo", tenants=[TenantConfig(**base)])


class TestAuthenticate:
    def test_valid_key_returns_context(self) -> None:
        service = TenantService(make_config())
        ctx = service.authenticate("demo-key")
        assert ctx.tenant_id == "demo"

    @pytest.mark.parametrize("bad", [None, "", "   ", "wrong-key"])
    def test_missing_or_unknown_key_rejected(self, bad: str | None) -> None:
        service = TenantService(make_config())
        with pytest.raises(AuthError) as exc_info:
            service.authenticate(bad)
        assert exc_info.value.code == "unauthorized"  # → HTTP 401

    def test_disabled_tenant_rejected_with_403_semantics(self) -> None:
        service = TenantService(make_config(enabled=False))
        with pytest.raises(AuthError) as exc_info:
            service.authenticate("demo-key")
        assert exc_info.value.code == "tenant_disabled"  # → HTTP 403

    def test_runtime_disable_toggle(self) -> None:
        """运行时禁用/恢复（403 场景的管理与测试入口）。"""
        service = TenantService(make_config())
        service.set_enabled("demo", False)
        with pytest.raises(AuthError, match="disabled"):
            service.authenticate("demo-key")
        service.set_enabled("demo", True)
        assert service.authenticate("demo-key").tenant_id == "demo"

    def test_unknown_tenant_id_not_found(self) -> None:
        with pytest.raises(NotFoundError):
            TenantService(make_config()).tenant_by_id("ghost")


class TestMessageQuota:
    def test_quota_exhausted_raises_with_retry_after(self) -> None:
        service = TenantService(make_config())
        for _ in range(3):  # max_messages_per_day = 3
            service.check_message_quota("demo")
            service.record_message("demo")
        with pytest.raises(QuotaError) as exc_info:
            service.check_message_quota("demo")
        assert exc_info.value.retry_after_seconds >= 1
        assert exc_info.value.code == "quota_exceeded"  # → HTTP 429

    def test_counter_resets_across_utc_day(self) -> None:
        """跨 UTC 自然日：计数惰性清零（注入时钟，不真实等待）。"""
        clock = {"now": datetime(2026, 10, 13, 23, 59, 30, tzinfo=timezone.utc)}
        service = TenantService(make_config(), now_fn=lambda: clock["now"])
        for _ in range(3):
            service.record_message("demo")
        clock["now"] += timedelta(seconds=60)  # 次日
        service.check_message_quota("demo")  # 不应抛 QuotaError
        assert service.usage_snapshot("demo")["usage"]["messages_today"] == 0

    def test_usage_snapshot_shape(self) -> None:
        service = TenantService(make_config())
        service.record_message("demo")
        service.register_task("demo", "t-1")
        snapshot = service.usage_snapshot("demo")
        assert snapshot["id"] == "demo"
        assert snapshot["usage"] == {"messages_today": 1, "active_tasks": 1}
        assert snapshot["quota"] == {
            "max_concurrent_tasks": 2,
            "max_messages_per_day": 3,
        }


class TestConcurrentTaskQuota:
    def test_concurrent_limit_enforced(self) -> None:
        service = TenantService(make_config())  # max_concurrent_tasks = 2
        service.register_task("demo", "t-1")
        service.register_task("demo", "t-2")
        with pytest.raises(QuotaError, match="concurrent task"):
            service.register_task("demo", "t-3")

    def test_release_frees_slot(self) -> None:
        service = TenantService(make_config())
        service.register_task("demo", "t-1")
        service.register_task("demo", "t-2")
        service.release_task("demo", "t-1")
        service.register_task("demo", "t-3")  # 不应抛错
        assert service.usage_snapshot("demo")["usage"]["active_tasks"] == 2

    def test_release_is_idempotent(self) -> None:
        service = TenantService(make_config())
        service.register_task("demo", "t-1")
        service.release_task("demo", "t-1")
        service.release_task("demo", "t-1")  # 重复释放不应抛错

    def test_multiple_tenants_isolated(self) -> None:
        config = TenancyConfig(
            default_tenant="a",
            tenants=[
                TenantConfig(
                    id="a", name="A", api_key="key-a",
                    max_concurrent_tasks=1, max_messages_per_day=10,
                ),
                TenantConfig(
                    id="b", name="B", api_key="key-b",
                    max_concurrent_tasks=1, max_messages_per_day=10,
                ),
            ],
        )
        service = TenantService(config)
        service.register_task("a", "t-1")
        service.register_task("b", "t-9")  # 各自独立额度
        with pytest.raises(QuotaError):
            service.register_task("a", "t-2")
        assert service.authenticate("key-b").tenant_id == "b"
