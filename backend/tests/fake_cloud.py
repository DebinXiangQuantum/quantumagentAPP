"""FakeCloudProvider：lqcloud 网络层的进程内替身（测试专用，零网络）。

对齐 lqcloud 0.5.1 被 :mod:`qap.hardware.lqcloud_adapter` 消费的最小面：
``provider.get_backends()`` / ``provider.get_backend(name)`` /
``backend.run(circuit, shots=..., readout_correction=...)`` /
``job.status_info()`` / ``job.result(...)``（返回真实 :class:`lqcloud.Result`，
只伪造云端回包）。

行为模型：
- ``run()`` 记录提交（backend 名/shots/序列化指令/barrier 断言用），用真实
  ``lqcloud.backend.serialization.serialize_circuit`` 序列化线路（转换器产物
  的真实验证），创建 FakeJob；
- FakeJob 的轮询按**脚本**推进：每次 ``status_info()`` 弹出下一个
  ``(status, queue_position)``；耗尽后停在最后一项；``result()`` 返回
  预置 counts（真实 Result 对象，get_counts 可用）；
- 提交时可注入故障：``fail_with``（提交即抛，如 CircuitError）与
  ``terminal_error``（终态 failed + 服务端错误消息）。
"""

from __future__ import annotations

import copy
from typing import Any, Optional

from lqcloud.backend.serialization import serialize_circuit
from lqcloud.exceptions import CircuitError
from lqcloud.job.result import Result
from lqcloud.job.status import JobStatus


#: 现网同构的 5 台真机样例（实测 2026-10-14：4 active + 1 offline）。
#: 拓扑形状对齐真实回包：qubit_coordinates 为 **dict**（键=比特下标字符串
#: → [x,y]）、rows/cols 显式、coupling_map 为 [a,b] 对列表（无保真度）。
DEFAULT_FAKE_BACKENDS: list[dict[str, Any]] = [
    {
        "name": "MQ02",
        "chip_architecture": "AGate 100",
        "status": "active",
        "qubits": 4,
        "topology": {
            "type": "grid",
            "rows": 2,
            "cols": 2,
            "qubit_coordinates": {"0": [0, 0], "1": [1, 0], "2": [1, 1], "3": [0, 1]},
            "coupling_map": [[0, 1], [1, 2], [2, 3], [3, 0]],
        },
    },
    {
        "name": "AGate-100",
        "chip_architecture": "AGate 100",
        "status": "active",
        "qubits": 4,
        "topology": {
            "rows": 1,
            "cols": 4,
            "qubit_coordinates": {"0": [0, 0], "1": [1, 0], "2": [2, 0], "3": [3, 0]},
            "coupling_map": [[0, 1], [1, 2], [2, 3]],
        },
    },
    {
        "name": "QZ01-surface_code",
        "chip_architecture": "AGate 165",
        "status": "active",
        "qubits": 6,
        "topology": {
            "rows": 2,
            "cols": 3,
            "qubit_coordinates": {
                "0": [0, 0], "1": [1, 0], "2": [2, 0],
                "3": [0, 1], "4": [1, 1], "5": [2, 1],
            },
            "coupling_map": [[0, 1], [1, 2], [3, 4], [4, 5], [0, 3], [1, 4], [2, 5]],
        },
    },
    {
        "name": "QZ01-repetition_code",
        "chip_architecture": "AGate 165",
        "status": "active",
        "qubits": 12,
        "topology": {
            # 一维链水平摆放：显式 rows=1、cols=12
            "rows": 1,
            "cols": 12,
            "qubit_coordinates": {str(i): [i, 0] for i in range(12)},
            "coupling_map": [[i, i + 1] for i in range(11)],
        },
    },
    {
        "name": "QZ02",
        "chip_architecture": "AGate 30",
        "status": "offline",
        "qubits": 20,
        "topology": {
            # 环形链（对齐实测 QZ02 形状的缩小版）：坐标绕 4x4 网格一周
            "type": "grid",
            "rows": 4,
            "cols": 4,
            "qubit_coordinates": {
                "0": [0, 0], "1": [1, 0], "2": [2, 0], "3": [3, 0],
                "4": [3, 1], "5": [3, 2], "6": [3, 3], "7": [2, 3],
                "8": [1, 3], "9": [0, 3],
            },
            "coupling_map": [[i, i + 1] for i in range(9)],
        },
    },
]


class FakeJob:
    """lqcloud Job 替身：脚本化轮询 + 预置结果/终态错误。"""

    def __init__(
        self,
        job_id: str,
        backend_name: str,
        poll_script: list[tuple[str, Optional[int]]],
        counts: dict[str, int],
        terminal_error: Optional[str] = None,
    ) -> None:
        self.job_id = job_id
        self.backend_name = backend_name
        self._script = list(poll_script)
        self._counts = dict(counts)
        self._terminal_error = terminal_error
        self._status: str = self._script[0][0] if self._script else "completed"
        self.status_calls = 0

    def status_info(self) -> dict[str, Any]:
        """一次轮询：弹出脚本下一项（耗尽后保持终态）。"""
        self.status_calls += 1
        if self._script:
            self._status, position = self._script.pop(0)
        else:
            position = None
        info: dict[str, Any] = {
            "job_id": self.job_id,
            "qpu_name": self.backend_name,
            "status": self._status,
            "queue_position": position if self._status in ("queued", "pending") else None,
        }
        if self._status == "failed":
            info["error"] = self._terminal_error or "cloud job failed"
            info["error_type"] = "hardware_error"
        return info

    def status(self) -> JobStatus:
        """枚举版状态（对齐真实 Job；内部复用 status_info 的当前态）。"""
        return JobStatus.from_str(self._status)

    def result(self, timeout: Optional[int] = None, wait: int = 2, verbose: bool = True):
        """终态取结果：completed → 真实 Result；failed/cancelled → JobError。
        （错误分支由真实 SDK 的 ``result()`` 负责——这里对齐其行为。）"""
        from lqcloud.exceptions import JobError

        if self._status == "completed":
            return Result(
                backend_name=self.backend_name,
                job_id=self.job_id,
                status=self._status,
                data={
                    "counts": dict(self._counts),
                    "result_format": "counts",
                    "shots": sum(self._counts.values()),
                },
            )
        raise JobError(
            f"Job {self.job_id} {self._status}: {self._terminal_error or 'unknown error'}",
            job_id=self.job_id,
        )


class FakeCloudBackend:
    """lqcloud CloudBackend 替身：记录提交并创建 FakeJob。"""

    def __init__(self, provider: "FakeCloudProvider", name: str) -> None:
        self._provider = provider
        self.name = name

    def run(self, circuit, shots: int = 1024, **kwargs) -> FakeJob:
        """提交：真实序列化线路（转换器断言用）→ 提交日志 → FakeJob。"""
        if self._provider.fail_with is not None:
            raise self._provider.fail_with
        instructions = serialize_circuit(circuit).get("instructions", [])
        job_id = f"task_fake_{len(self._provider.submissions) + 1:04d}"
        submission = {
            "job_id": job_id,
            "backend_name": self.name,
            "shots": shots,
            "readout_correction": bool(kwargs.get("readout_correction", False)),
            "instructions": instructions,
        }
        self._provider.submissions.append(submission)
        job = FakeJob(
            job_id=job_id,
            backend_name=self.name,
            poll_script=list(self._provider.poll_script),
            counts=dict(self._provider.counts),
            terminal_error=self._provider.terminal_error,
        )
        self._provider.jobs[job_id] = job
        return job


class FakeCloudProvider:
    """lqcloud LQCloudProvider 替身（构造可注入，零网络）。"""

    def __init__(
        self,
        backends: list[dict[str, Any]] | None = None,
        *,
        poll_script: list[tuple[str, Optional[int]]] | None = None,
        counts: dict[str, int] | None = None,
        fail_with: Exception | None = None,
        terminal_error: str | None = None,
        fetch_error: Exception | None = None,
    ) -> None:
        self.backends = copy.deepcopy(backends or DEFAULT_FAKE_BACKENDS)
        self.poll_script = poll_script or [("queued", 1), ("running", None), ("completed", None)]
        self.counts = counts or {"00": 128, "11": 128}
        self.fail_with = fail_with
        self.terminal_error = terminal_error
        self.fetch_error = fetch_error
        self.submissions: list[dict[str, Any]] = []
        self.jobs: dict[str, FakeJob] = {}

    def get_backends(self) -> list[dict[str, Any]]:
        """后端发现；``fetch_error`` 非空时模拟云端不可达。"""
        if self.fetch_error is not None:
            raise self.fetch_error
        return copy.deepcopy(self.backends)

    def get_backend(self, name: str) -> FakeCloudBackend:
        """按名取 backend；未知名对齐真实 SDK 抛 BackendNotFoundError。"""
        from lqcloud.exceptions import BackendNotFoundError

        if not any(b.get("name") == name for b in self.backends):
            raise BackendNotFoundError(f"Backend '{name}' not found")
        return FakeCloudBackend(self, name)


#: 便于测试断言"提交即抛 CircuitError"的现成异常
CIRCUIT_ERROR = CircuitError("cloud rejected circuit: measure must follow a barrier")
