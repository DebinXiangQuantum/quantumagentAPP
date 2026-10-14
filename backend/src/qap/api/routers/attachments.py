"""附件端点（契约 §5 v1.3）：上传（multipart）与 raw 读取。

- ``POST /api/v1/conversations/{cid}/attachments``：multipart ``file``，
  单文件 ≤ 8MB；空文件/超限 → 422（非 multipart 由 FastAPI 表单解析
  直接 422）；kind 判定见 ``domain/attachments.classify_kind``；
  → 201 ``AttachmentMeta``（内存存储）。
- ``GET /api/v1/attachments/{id}/raw``：原字节 + 存储 mime；
  同租户隔离（跨租户 → 404，与不存在同语义）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Response, UploadFile

from qap.api.deps import get_state, require_tenant
from qap.api.state import AppState
from qap.domain.attachments import (
    AttachmentRecord,
    classify_kind,
    validate_upload,
)
from qap.tenancy.service import TenantContext

router = APIRouter(tags=["attachments"], dependencies=[Depends(require_tenant)])


@router.post("/conversations/{conversation_id}/attachments", status_code=201)
async def upload_attachment(
    conversation_id: str,
    file: UploadFile = File(...),
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> dict:
    """上传一个附件到会话（multipart file；大小/空文件校验 → 422）。"""
    conversation = state.conversations.get(conversation_id, tenant.tenant_id)
    data = await file.read()
    name = file.filename or ""
    mime = file.content_type or "application/octet-stream"
    validate_upload(name, mime, data)  # 空/超限 → ValidationFailed → 422
    record = AttachmentRecord(
        id=state.idgen.next("att"),
        conversation_id=conversation.id,
        tenant_id=tenant.tenant_id,
        name=name,
        mime=mime,
        size=len(data),
        kind=classify_kind(name, mime),
        data=data,
    )
    state.attachments.add(record)
    return record.meta().model_dump()


@router.get("/attachments/{attachment_id}/raw")
async def get_attachment_raw(
    attachment_id: str,
    tenant: TenantContext = Depends(require_tenant),
    state: AppState = Depends(get_state),
) -> Response:
    """附件原始字节（同租户隔离：跨租户 404，与不存在同语义）。"""
    record = state.attachments.get(attachment_id, tenant.tenant_id)
    return Response(
        content=record.data,
        media_type=record.mime,
        headers={"Content-Disposition": f'inline; filename="{record.name}"'},
    )
