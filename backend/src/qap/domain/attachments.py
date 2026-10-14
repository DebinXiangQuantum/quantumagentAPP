"""附件：内存存储与 kind 判定（契约 §5 v1.3）。

- ``classify_kind(name, mime)``：``image/*`` → image；``text/*`` 或文本
  扩展名 {.md,.txt,.py,.json,.toml,.csv,.yaml,.ts,.js} → text；其余 file。
- :class:`AttachmentStore`：进程内字节存储（原型无对象存储）；按
  ``tenant_id`` 过滤的 404 语义与其它 Store 一致（跨租户=不存在）。
- 文本附件注入 Provider 上下文时的截断上限（200k 字符，契约 §5 v1.3）。
"""

from __future__ import annotations

from dataclasses import dataclass

from qap.core.errors import NotFoundError, ValidationFailed
from qap.domain.models import AttachmentMeta

#: 单文件大小上限（契约 §5 v1.3：≤ 8MB）
MAX_ATTACHMENT_SIZE_BYTES = 8 * 1024 * 1024
#: 文本附件注入 user 上下文的截断上限（字符）
TEXT_INJECTION_CHAR_LIMIT = 200_000
#: 判为 text 类的扩展名（契约枚举）
TEXT_EXTENSIONS = frozenset(
    {".md", ".txt", ".py", ".json", ".toml", ".csv", ".yaml", ".ts", ".js"}
)


def classify_kind(name: str, mime: str) -> str:
    """按契约判定附件类别（image/text/file）；mime 优先，扩展名兜底。"""
    normalized_mime = (mime or "").strip().lower()
    if normalized_mime.startswith("image/"):
        return "image"
    if normalized_mime.startswith("text/"):
        return "text"
    lower_name = (name or "").lower()
    dot = lower_name.rfind(".")
    if dot >= 0 and lower_name[dot:] in TEXT_EXTENSIONS:
        return "text"
    return "file"


@dataclass(frozen=True)
class AttachmentRecord:
    """一份已上传附件的完整记录（元数据 + 字节；内存态）。"""

    id: str
    conversation_id: str
    tenant_id: str
    name: str
    mime: str
    size: int
    kind: str
    data: bytes

    def meta(self) -> AttachmentMeta:
        """对外元数据视图（不含字节，契约 §5 AttachmentMeta）。"""
        return AttachmentMeta(
            id=self.id,
            name=self.name,
            mime=self.mime,
            size=self.size,
            kind=self.kind,  # type: ignore[arg-type]
        )


def validate_upload(name: str, mime: str, data: bytes) -> None:
    """上传期校验（契约 §5：空文件/超限 → 422）。"""
    if not name or not name.strip():
        raise ValidationFailed("attachment file name must be non-empty")
    if not data:
        raise ValidationFailed("attachment file is empty (zero bytes)")
    if len(data) > MAX_ATTACHMENT_SIZE_BYTES:
        raise ValidationFailed(
            f"attachment exceeds 8MB limit ({len(data)} bytes)"
        )


class AttachmentStore:
    """附件表：id → AttachmentRecord（会话/租户归属在记录上）。"""

    def __init__(self) -> None:
        self._items: dict[str, AttachmentRecord] = {}

    def add(self, record: AttachmentRecord) -> AttachmentRecord:
        if record.id in self._items:
            raise ValueError(f"duplicate attachment id {record.id!r}")
        self._items[record.id] = record
        return record

    def get(self, attachment_id: str, tenant_id: str) -> AttachmentRecord:
        """取附件（跨租户 → NotFoundError，与不存在同语义）。"""
        record = self._items.get(attachment_id)
        if record is None or record.tenant_id != tenant_id:
            raise NotFoundError("attachment", attachment_id)
        return record

    def get_for_conversation(
        self, attachment_id: str, conversation_id: str, tenant_id: str
    ) -> AttachmentRecord:
        """发消息校验用：必须存在且归属该会话与租户（否则 422 语义由
        调用方决定——本方法抛 ValidationFailed，契约：未知/跨会话 → 422）。"""
        record = self._items.get(attachment_id)
        if (
            record is None
            or record.tenant_id != tenant_id
            or record.conversation_id != conversation_id
        ):
            raise ValidationFailed(
                f"attachment {attachment_id!r} does not belong to this conversation"
            )
        return record
