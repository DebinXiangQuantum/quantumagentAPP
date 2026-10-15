"""Provider 抽象基座：请求/事件类型与 LLMProvider 协议（契约 §9）。

消息格式（provider 无关的内部中间表示，由 Runtime 构造）：
- ``{"role": "system"|"user"|"assistant", "content": str}``
- ``{"role": "assistant", "content": str, "tool_calls": [ToolCallRecord]}``
- ``{"role": "tool", "tool_call_id": str, "name": str, "content": str}``
各 Provider 负责把该中间表示翻译成自家 wire format（openai 原生接近；
anthropic 需转 tool_use/tool_result 块）。

事件流约定（契约 §9：text_delta | thought_delta | tool_call | error）：
- ``TextDelta``：一段正文增量文本（Runtime 直接进 SSE message.delta）；
- ``ThoughtDelta``：一段**思考过程**增量（v1.1：openai 的
  ``delta.reasoning_content``（GLM/DeepSeek 式）与 anthropic 的
  ``thinking_delta`` 归一化；Runtime 进 SSE message.reasoning）；
- ``ToolCall``：一次完整的工具调用（name + arguments **JSON 字符串**，
  增量拼接由 Provider 内部完成后才发出）；
- ``ProviderErrorEvent``：Provider 侧故障（非 200、流中断、密钥缺失……），
  之后流终止、**不再**发 TurnCompleted；
- ``TurnCompleted``：本轮正常结束（内部控制事件，stop_reason 告诉
  Runtime 是否需要回填工具结果并继续循环）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from qap.core.config import ThinkingLevel


@dataclass(frozen=True)
class AttachmentPart:
    """消息附件的 provider 侧形态（v1.3 §5/§9 注入语义）。

    由组装根的 resolver 从 AttachmentRecord 构造：
    - kind=text：``text`` 为解码并截断（200k 字符）后的全文，
      provider 以文本形式注入 user 上下文；
    - kind=image：``data_base64`` 为图片字节，openai → ``image_url``
      （data URL）、anthropic → image block（**需视觉模型**——文本模型
      的服务端错误经 ProviderErrorEvent → SSE error 透传）；
    - kind=file：仅元数据（不注入内容）。
    """

    id: str
    name: str
    mime: str
    kind: str  # "image" | "text" | "file"
    text: str | None = None
    data_base64: str | None = None

    def summary(self) -> dict[str, str]:
        """日志/记录型 provider（测试替身）用的元数据摘要（无内容体）。"""
        return {"id": self.id, "name": self.name, "mime": self.mime, "kind": self.kind}


@dataclass(frozen=True)
class CompletionRequest:
    """一次补全请求（provider 无关）。

    ``metadata`` 携带运行上下文（run_key / agent_id / conversation_id）：
    测试替身用 run_key 推进脚本游标，openai/anthropic 忽略之。
    ``thinking_level``（v1.1 §9）：归一化思考程度，由 Runtime 按优先级
    解析（消息级 > 渠道 default_thinking）；None 表示"未指定"——provider
    不发送任何思考参数（向后兼容，仅单元测试/子运行直达路径会出现）。

    消息 dict 可携带 ``"attachments": [AttachmentPart]``（v1.3）——
    Runtime 从带附件的 user 消息构造，provider 负责翻译为自家 wire
    format（openai：text 追加 / image_url data URL；anthropic：文本块 /
    image block；记录型 provider 仅记录摘要）。
    """

    model: str
    messages: list[dict[str, Any]]
    system: str | None = None
    tools: Sequence[Any] | None = None  # ToolSpec 序列（agents.plugins）
    metadata: dict[str, Any] = field(default_factory=dict)
    thinking_level: ThinkingLevel | None = None


@dataclass(frozen=True)
class TextDelta:
    """文本增量事件（契约 §9 text_delta）。"""

    text: str


@dataclass(frozen=True)
class ThoughtDelta:
    """思考过程增量事件（契约 §9 v1.1 thought_delta）；思考先于正文。"""

    text: str


@dataclass(frozen=True)
class ToolCall:
    """完整工具调用事件（契约 §9 tool_call）；arguments 为 JSON 字符串。"""

    name: str
    arguments: str


@dataclass(frozen=True)
class ProviderErrorEvent:
    """Provider 故障事件（契约 §9 error）；发出后流终止。"""

    message: str


@dataclass(frozen=True)
class TurnCompleted:
    """本轮正常结束（内部控制事件）。

    stop_reason：``"stop"`` 纯文本结束；``"tool_use"`` 本轮发生了工具调用，
    Runtime 应回填结果并再次 stream。
    """

    stop_reason: str


#: Provider 事件联合类型（供类型注解使用）
ProviderEvent = TextDelta | ThoughtDelta | ToolCall | ProviderErrorEvent | TurnCompleted


@dataclass(frozen=True)
class ToolCallRecord:
    """历史消息中的工具调用记录（中间表示，provider 翻译时使用）。"""

    id: str
    name: str
    arguments: str


def tool_fields(tool: object) -> tuple[str, str, dict]:
    """工具声明的统一读取：兼容 ToolSpec 对象与 dict 两种形态。

    Runtime 注入的平台工具是 dict（``PlatformTools.specs()``），插件领域
    工具经合并时也统一为 dict；单测/外部调用可能传 ToolSpec 对象——
    provider 侧一律经本函数归一化（v1 潜伏缺陷：真实 provider 只认对象
    属性，首条真实渠道调用即 AttributeError，冒烟发现于 2026-10-13）。
    """
    if isinstance(tool, dict):
        name = str(tool.get("name") or "")
        description = str(tool.get("description") or "")
        parameters = tool.get("parameters")
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
        return name, description, parameters
    return (
        str(getattr(tool, "name", "")),
        str(getattr(tool, "description", "")),
        dict(getattr(tool, "parameters", {}) or {}),
    )


class LLMProvider(Protocol):
    """统一 LLM Provider 协议（契约 §9）。"""

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        """流式补全：按到达顺序产出 ProviderEvent，永不抛网络异常
        （一律转 ProviderErrorEvent 事件，便于 Runtime 统一处理）。"""
        ...
