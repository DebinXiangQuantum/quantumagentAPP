"""FastAPI 应用工厂与 lifespan（DoD 入口：``uvicorn qap.main:app``）。

启动序列（fail-fast）：
1. :func:`qap.core.config.load_config` 定位并校验 config.toml
   （缺键/类型错/悬空引用等 → 进程拒绝启动，契约 §3）；
2. ``build_app_state`` 组装全部服务；
3. lifespan 内按 ``hardware.simulated`` 启动利用率模拟器，关停时停止。

CORS 白名单来自 config（前端 Vite dev server 5173 已在默认配置中）。
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from qap import __version__
from qap.api.errors import qap_error_handler
from qap.api.routers import api_router
from qap.api.state import AppState, build_app_state
from qap.core.config import AppConfig, LoadedConfig, load_config_with_sources
from qap.core.errors import QapError


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """启动模拟器；关停时停止并取消未完成的后台 Agent 运行。"""
    state: AppState = app.state.qap
    if state.config.hardware.simulated:
        state.simulator.start()
    yield
    await state.shutdown()


def create_app(
    config: AppConfig | LoadedConfig | None = None,
    *,
    cloud_adapter: object | None = None,
) -> FastAPI:
    """构造 FastAPI 应用。

    ``config`` 可注入已加载的 ``AppConfig``/``LoadedConfig``（测试）；
    None 时按契约加载（基底 config.toml ← 同目录 config.local.toml 深合并）。
    ``cloud_adapter``（v1.4）：logicalcloud 模式适配器注入点（测试用
    FakeCloudProvider 包装；None = 生产真实 ``LQCloudProvider``，
    密钥缺失/云端不可达 → 启动 fail-fast）。
    """
    resolved = config if config is not None else load_config_with_sources()
    resolved_config = resolved.config if isinstance(resolved, LoadedConfig) else resolved
    app = FastAPI(
        title="QuantumAgentApp API",
        version=__version__,
        lifespan=_lifespan,
    )
    app.state.qap = build_app_state(resolved, cloud_adapter=cloud_adapter)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_config.server.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)
    app.add_exception_handler(QapError, qap_error_handler)
    # v1.9 部署：前端静态托管（同源——SPA 无客户端路由，直接 index.html
    # 兜底即可；QAP_FRONTEND_DIR 环境变量指向构建产物 dist/ 时启用）。
    frontend_dir = os.environ.get("QAP_FRONTEND_DIR")
    if frontend_dir and Path(frontend_dir).is_dir():
        from fastapi.staticfiles import StaticFiles

        app.mount(
            "/",
            StaticFiles(directory=frontend_dir, html=True),
            name="frontend",
        )
    return app


#: uvicorn 入口（PYTHONPATH=src python -m uvicorn qap.main:app）。
#:
#: PEP 562 惰性创建（v1.4）：import 本模块**不**触发真实配置加载/云适配器
#: 构建——否则本机 config.local.toml 为 logicalcloud 模式而环境缺
#: LQCLOUD_API_KEY 时，任何 `import qap.main` 的测试都会在收集期爆炸。
#: uvicorn 以 `qap.main:app` 字符串导入后做属性访问，届时才真正 create_app()
#: （fail-fast 语义保持：真实启动缺配置仍立即报错）。
def __getattr__(name: str):
    if name == "app":
        return create_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
