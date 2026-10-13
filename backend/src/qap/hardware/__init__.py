"""hardware —— 异构硬件注册表、容量分配器与利用率模拟器（契约 §4/§7）。"""

from qap.hardware.allocator import Allocator, LeaseDenied
from qap.hardware.registry import NodeRegistry
from qap.hardware.simulator import UtilizationSimulator

__all__ = ["Allocator", "LeaseDenied", "NodeRegistry", "UtilizationSimulator"]
