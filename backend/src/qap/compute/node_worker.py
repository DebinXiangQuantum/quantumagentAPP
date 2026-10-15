"""计算节点执行器（node worker）——运行在 CPU/GPU 节点机器上的轻量服务。

部署语义（v1.7 平台能力）：classical 步携带 code 时，后端**只分发不执行**
——代码经 HTTP /execute 送至节点机器上的本 worker，由节点自己的 Python
环境真实执行（子进程 + 临时工作目录 + 可选 pip 装包 + 超时强杀）。真实
部署：`PYTHONPATH=src uvicorn qap.compute.node_worker:app --port 8301`
（或 create_worker_app 工厂）运行于每台计算节点。

安全边界（内部平台原型）：worker 不做代码审计——节点机器视为受信执行
环境（与集群调度同信任级）；超时/输出截断防止资源失控；packages 装入
节点 Python 环境（幂等，已装即跳过）。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field, field_validator

#: 单次执行输出截断上限（字节）——stdout/stderr 各自截断，防撑爆回包
OUTPUT_LIMIT_BYTES = 64 * 1024
#: 请求允许的最大超时（秒）——超出的按上限夹取（调度器另有全局步超时）
MAX_TIMEOUT_SECONDS = 900.0


class ExecuteRequest(BaseModel):
    """一次代码执行请求（后端调度器 → 节点 worker）。"""

    code: str = Field(min_length=1)
    packages: list[str] = Field(default_factory=list)
    timeout_s: float = Field(gt=0)

    @field_validator("packages")
    @classmethod
    def _reject_bad_package_names(cls, value: list[str]) -> list[str]:
        """包名校验：非空字符串；含空白/命令注入字符直接拒绝（422）。"""
        for name in value:
            if not isinstance(name, str) or not name.strip():
                raise ValueError("package names must be non-empty strings")
            if any(ch in name for ch in ";&|`$><\n"):
                raise ValueError(f"suspicious package name {name!r}")
        return value


class ExecuteResult(BaseModel):
    """执行结果（节点真实测量：子进程墙钟 + RUSAGE 峰值 RSS）。"""

    exit_code: int
    stdout: str
    stderr: str
    duration_ms: float
    peak_rss_mb: float | None = None
    timed_out: bool = False
    installed_packages: list[str] = Field(default_factory=list)


def _truncate(text: str) -> str:
    """输出截断（保留尾部——错误栈通常在末尾）。"""
    if len(text.encode("utf-8", errors="replace")) <= OUTPUT_LIMIT_BYTES:
        return text
    return "...[truncated]..." + text[-(OUTPUT_LIMIT_BYTES // 2):]


def create_worker_app(node_name: str = "compute-node") -> FastAPI:
    """构造节点 worker 应用（测试经 ASGITransport 直连；部署经 uvicorn）。"""

    app = FastAPI(title="QAP Node Worker", version="1.7.0")

    @app.get("/health")
    async def health() -> dict:
        """心跳：节点名 + 节点 Python 版本（部署核对面）。"""
        return {
            "status": "ok",
            "node": node_name,
            "python": sys.version.split()[0],
        }

    @app.post("/execute", response_model=ExecuteResult)
    async def execute(request: ExecuteRequest) -> ExecuteResult:
        """在节点上真实执行代码（同步子进程；FastAPI 线程池承接）。"""
        timeout = min(request.timeout_s, MAX_TIMEOUT_SECONDS)
        installed: list[str] = []
        # 可选装包：节点环境幂等安装（已装即跳过；失败原样上抛为 5xx，
        # 由客户端转成步骤错误——不静默吞掉网络/仓源问题）
        if request.packages:
            proc = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", *request.packages],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            if proc.returncode != 0:
                return ExecuteResult(
                    exit_code=proc.returncode,
                    stdout=_truncate(proc.stdout),
                    stderr=_truncate("pip install failed:\n" + proc.stderr),
                    duration_ms=0.0,
                    installed_packages=[],
                )
            installed = list(request.packages)

        # 临时工作目录执行（互不污染；结束后保留由系统清理策略处理）
        workdir = Path(tempfile.mkdtemp(prefix="qap-node-exec-"))
        script = workdir / "task.py"
        script.write_text(request.code, encoding="utf-8")

        import resource

        rss_before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        started = time.perf_counter()
        try:
            proc = subprocess.run(
                [sys.executable, str(script)],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(workdir),
            )
            timed_out = False
            exit_code = proc.returncode
            stdout, stderr = proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = -1
            stdout = exc.stdout.decode("utf-8", "replace") if exc.stdout else ""
            stderr = (
                f"timeout after {timeout}s (killed)"
                + (exc.stderr.decode("utf-8", "replace") if exc.stderr else "")
            )
        duration_ms = (time.perf_counter() - started) * 1000.0
        # 峰值 RSS：RUSAGE_CHILDREN 的 ru_maxrss 为累计最大值（KB，macOS/Linux
        # 语义一致）——取与本次执行的较大者，无法归因时退化为该累计值
        rss_after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        peak_mb = round(max(rss_after, rss_before) / 1024.0, 1) or None
        return ExecuteResult(
            exit_code=exit_code,
            stdout=_truncate(stdout),
            stderr=_truncate(stderr),
            duration_ms=round(duration_ms, 1),
            peak_rss_mb=peak_mb,
            timed_out=timed_out,
            installed_packages=installed,
        )

    return app


#: uvicorn 部署入口（PYTHONPATH=src uvicorn qap.compute.node_worker:app）
app = create_worker_app()
