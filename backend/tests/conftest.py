

# ---- qiskit 早期预载（原生扩展加载顺序确定性）-------------------------------
# 现象：全量套件中 lqmap（qiskit Rust 扩展）在其它原生库（conda 基座的
# BLAS/OpenMP 等）之后才首次 import 会发生进程级崩溃；先单独 import 任意
# qiskit 子模块（如 algorithms 占位）可固定加载顺序。qiskit 未安装
# （未装 [hardware] extra）时静默跳过——路由编译回退直构路径。
try:  # pragma: no cover - 环境相关，非逻辑分支
    import qiskit  # noqa: F401
except Exception:  # pragma: no cover
    pass
