"""lqmap —— logicalcloud 噪声自适应编译（迁自本组博士生项目，见模块头出处）。

职责：把逻辑线路（任意两比特门）映射到目标真机耦合图——噪声自适应子图
选择 + SABRE 布局/路由 + 保真度择优（SWAP 自动插入，非相邻门不再被平台
拒收，从而支持问题真实规模的线路）。
依赖 qiskit（backend 可选 extra [hardware]）；不可用时适配层回退直构路径。
"""

from .qubit_mapping_compiler import Calibration, NoiseAwareCompiler  # noqa: F401
