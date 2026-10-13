"""core —— 无领域偏见的横切基础设施：配置、错误、id 生成。"""

from qap.core.config import AppConfig, ConfigError, load_config
from qap.core.errors import QapError
from qap.core.ids import IdGenerator

__all__ = ["AppConfig", "ConfigError", "QapError", "IdGenerator", "load_config"]
