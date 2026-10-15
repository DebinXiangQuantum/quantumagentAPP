"""V3 租户角色与管理守卫测试（契约 §5 v1.2 管理权限与租户角色）。

四类场景映射：
- 不变量：role ∈ {user,admin}（缺省 user）；/tenants/me 含 role；
  全部 /api/v1/admin/* 端点（models CRUD + plugins 全生命周期）对
  非 admin 一律 403 `{"error":{"code":"forbidden"}}`。
- 非法输入拒绝：config role 非法值启动拒绝。
- 负样本：demo（user）访问全部 admin 端点 → 403（守卫先于端点自身
  校验，畸形 payload 也先吃 403）；未知 key 仍 401（鉴权先于授权）；
  disabled admin → 403 tenant_disabled（鉴权语义优先）。
- 可观察行为：admin（admin-key）过守卫（端点自身语义的状态码）；
  admin 渠道 CRUD 端到端（demo 403 / admin 200/204）。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from qap.core.config import TenantConfig
from tests.test_api_integration import ClientBundle, make_test_config

DEMO = {"Authorization": "Bearer demo-key"}
ADMIN = {"Authorization": "Bearer admin-key"}

#: 全部 admin 端点（方法, 路径, 请求体）——守卫必须逐一覆盖；
#: admin 侧只断言"过了守卫"（状态码由端点自身语义决定）。
ALL_ADMIN_ENDPOINTS: list[tuple[str, str, dict | None]] = [
    ("GET", "/api/v1/admin/models", None),
    ("PUT", "/api/v1/admin/models/guard-chan",
     {"provider": "openai", "model": "x", "base_url": "http://test.invalid/v1",
      "api_key_env": "QAP_TEST_KEY"}),
    ("DELETE", "/api/v1/admin/models/guard-chan", None),
    ("GET", "/api/v1/admin/plugins", None),
    ("POST", "/api/v1/admin/plugins/install", {"source_path": "/nonexistent-xyz"}),
    ("PUT", "/api/v1/admin/plugins/echo", {"enabled": False}),
    ("DELETE", "/api/v1/admin/plugins/echo", None),
]


def role_bundle() -> ClientBundle:
    """demo=user（缺省）+ admin(admin-key)=admin 的双角色测试束。"""
    config = make_test_config()
    config.tenancy.tenants.append(
        TenantConfig(
            id="admin", name="管理员", api_key="admin-key",
            max_concurrent_tasks=8, max_messages_per_day=10000, role="admin",
        )
    )
    return ClientBundle(config)


async def close(bundle: ClientBundle) -> None:
    await bundle.app.state.qap.shutdown()
    await bundle.http.aclose()


class TestRoleConfig:
    def test_role_defaults_user(self) -> None:
        tenant = TenantConfig(
            id="t", name="T", api_key="k",
            max_concurrent_tasks=1, max_messages_per_day=1,
        )
        assert tenant.role == "user"

    def test_role_invalid_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TenantConfig(
                id="t", name="T", api_key="k",
                max_concurrent_tasks=1, max_messages_per_day=1, role="root",
            )

    def test_role_admin_accepted(self) -> None:
        tenant = TenantConfig(
            id="t", name="T", api_key="k",
            max_concurrent_tasks=1, max_messages_per_day=1, role="admin",
        )
        assert tenant.role == "admin"


class TestTenantsMeRole:
    @pytest.fixture()
    async def bundle(self) -> ClientBundle:
        instance = role_bundle()
        yield instance
        await close(instance)

    async def test_me_contains_role_user(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/tenants/me", headers=DEMO)
        assert response.status_code == 200
        body = response.json()
        assert body["role"] == "user"
        assert set(body) >= {"id", "name", "enabled", "role", "usage", "quota"}

    async def test_me_role_admin(self, bundle: ClientBundle) -> None:
        response = await bundle.http.get("/api/v1/tenants/me", headers=ADMIN)
        assert response.status_code == 200
        assert response.json()["role"] == "admin"


class TestAdminGuard:
    @pytest.fixture()
    async def bundle(self) -> ClientBundle:
        instance = role_bundle()
        yield instance
        await close(instance)

    @pytest.mark.parametrize("method,path,payload", ALL_ADMIN_ENDPOINTS)
    async def test_user_role_403_on_every_admin_endpoint(
        self, bundle: ClientBundle, method: str, path: str, payload: dict | None,
    ) -> None:
        """demo（role=user）访问任一 admin 端点 → 403 forbidden（守卫先于
        端点自身校验——即使该请求本会 409/422/404 也先吃 403）。"""
        response = await bundle.http.request(method, path, json=payload, headers=DEMO)
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "forbidden"
        assert response.json()["error"]["message"]

    async def test_guard_precedes_payload_validation(self, bundle: ClientBundle) -> None:
        """守卫优先：畸形 payload + user 角色 → 仍是 403（非 422）。"""
        response = await bundle.http.put(
            "/api/v1/admin/models/x", json={"provider": "bogus"}, headers=DEMO
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"

    async def test_unknown_key_still_401_not_403(self, bundle: ClientBundle) -> None:
        """鉴权先于授权：未知 key → 401（不是 403）。"""
        response = await bundle.http.get(
            "/api/v1/admin/models", headers={"Authorization": "Bearer nope"}
        )
        assert response.status_code == 401

    async def test_disabled_admin_is_tenant_disabled(self, bundle: ClientBundle) -> None:
        """禁用的 admin 租户 → 403 tenant_disabled（鉴权语义，非 forbidden）。"""
        bundle.state.tenants.set_enabled("admin", False)
        response = await bundle.http.get("/api/v1/admin/models", headers=ADMIN)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "tenant_disabled"

    @pytest.mark.parametrize("method,path,payload", ALL_ADMIN_ENDPOINTS)
    async def test_admin_role_passes_guard(
        self, method: str, path: str, payload: dict | None,
    ) -> None:
        """admin-key 访问全部 admin 端点：过守卫（非 403；具体状态码由
        端点自身语义决定——每例独立 bundle，无跨例状态依赖）。"""
        instance = role_bundle()
        try:
            response = await instance.http.request(method, path, json=payload, headers=ADMIN)
            assert response.status_code != 403, response.text
        finally:
            await close(instance)

    async def test_admin_models_crud_end_to_end(self) -> None:
        """集成：demo 403 / admin 200 的渠道 CRUD 全流程（精确状态码）。"""
        instance = role_bundle()
        try:
            denied = await instance.http.get("/api/v1/admin/models", headers=DEMO)
            assert denied.status_code == 403
            created = await instance.http.put(
                "/api/v1/admin/models/guard-chan",
                json={"provider": "openai", "model": "scripted-demo",
                      "base_url": "http://test.invalid/v1",
                      "api_key_env": "QAP_TEST_KEY"},
                headers=ADMIN,
            )
            assert created.status_code == 200
            listing = (await instance.http.get(
                "/api/v1/admin/models", headers=ADMIN
            )).json()
            assert "guard-chan" in {m["ref"] for m in listing["models"]}
            deleted = await instance.http.delete(
                "/api/v1/admin/models/guard-chan", headers=ADMIN
            )
            assert deleted.status_code == 204
        finally:
            await close(instance)
