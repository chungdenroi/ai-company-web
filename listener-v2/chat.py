#!/usr/bin/env python3
"""Chat 2 chieu qua API cho worker phong hop Cong ty Enteesee.

OFFLINE / KHONG GUI THAT:
  Module nay CHI xay payload va dinh tuyen su kien den. No KHONG goi
  mang, KHONG dang nhap, KHONG doc/ghi Firestore live, KHONG nhan mat
  khau hay token duoi bat ky dang nao. Luc chay that, tang gui (nam
  ngoai module nay, do nguoi van hanh kiem soat) se lay mat khau qua
  stdin, sign-in IdentityToolkit, roi POST payload nay — theo dung mau
  da kiem chung trong `../hidden_files/firestore_watch.py` (chi doc,
  khong sua file do). O day KHONG copy API key hay thong tin dang
  nhap nao tu file do.

2 NANG LUC API CAN GHI RO (khong de hieu ngam):
  (1) NHAN THONG BAO qua API: worker giu luong Listen; su kien tag /
      viec / duyet toi la biet ngay, khong can trinh duyet.
  (2) CHAT 2 CHIEU qua API: worker dang tin vao phong bang danh tinh
      cua CHINH acc do, khong can trinh duyet. Nghe qua Listen + noi
      qua API la du vong chat 2 chieu, khong chi tra loi theo job.

RANH GIOI VOI LISTENER (doc ky, dung lan):
  - Listener quyet dinh DANH THUC (co goi ten worker / co phai viec
    cua worker / co can tra loi ngay khong).
  - Worker (module nay) chi dinh tuyen NOI DUNG da nhan duoc: tin nay
    thuoc luong chat, luong job, hay luong duyet.
  - Tin chat chung phong KHONG goi ten worker van tra ve "chat"
    (doc duoc, nam trong luong chat) — nhung no KHONG tu dong danh
    thuc worker. Danh thuc la viec cua listener, khong phai cua
    route_incoming().

Interface event dict nhan tu listener (khong import module listener):
  {"event_id", "collection", "kind", "sender_id", "sender_name",
   "content", "ts", "doc_id"}
  Cac key Firestore ("senderId", "senderName", "createdAt", "id")
  cung duoc chap nhan de de test / de noi.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

# Kind duoc coi la "viec that" — di vao may trang thai job (worker.py).
JOB_KINDS = {"Giao việc", "task_event", "Giao viec"}
# Kind duoc coi la "duyet" — di vao luan duyet (worker.validate_approval).
APPROVAL_KINDS = {"Duyệt", "Phê duyệt", "approval_event", "Duyet"}
# Kind tien do: ban cap nhat tien do cua mot job, khong phai chat tu do.
PROGRESS_KINDS = {"Cập nhật tiến độ", "progress_event", "Cap nhat tien do"}

_CHAT_KIND = "Trao đổi"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _s(value) -> str:
    """Lay chuoi, chap nhan ca None -> ''."""
    if value is None:
        return ""
    return str(value)


def _str_field(value: str) -> dict:
    return {"stringValue": value}


def _ts_field(value: str) -> dict:
    return {"timestampValue": value}


def _event_get(event: dict, *keys: str) -> str:
    for key in keys:
        if key in event and event[key] not in (None, ""):
            return _s(event[key])
    return ""


def build_chat_payload(own_sender_id: str, own_sender_name: str,
                       content: str, now_iso: str | None = None) -> dict:
    """Xay payload POST documents/messages cho mot tin chat tu do.

    Danh tinh LUON la cua chinh acc goi ham (own_sender_id/name).
    Ham nay khong co tham so nao de ghi sender cua nguoi khac, nen
    khong the dung no de mao danh — muon mao danh phai tu sua payload
    sau khi ham tra ve, va do la hanh vi bi cam, khong phai tinh nang.

    Payload KHONG BAO GIO chua mat khau/token: ham khong nhan, khong
    doc, khong ghi bat ky secret nao. Neu caller vo tinh truyen secret
    vao `content`, do la loi cua caller — test assert payload khong
    chua secret mau, nhung he thong that van can caller khong bao gio
    dan secret vao noi dung chat.

    Tra ve: payload Firestore REST, san sang POST toi
    `.../documents/messages` (tang gui that tu them Authorization).
    """
    sender_id = _s(own_sender_id).strip()
    sender_name = _s(own_sender_name).strip()
    text = _s(content).strip()
    if not sender_id:
        raise ValueError("build_chat_payload: own_sender_id rong — "
                         "khong dang tin khong danh tinh")
    if not sender_name:
        raise ValueError("build_chat_payload: own_sender_name rong — "
                         "khong dang tin khong danh tinh")
    if not text:
        raise ValueError("build_chat_payload: content rong — "
                         "khong dang tin trang")
    return {
        "fields": {
            "senderId": _str_field(sender_id),
            "senderName": _str_field(sender_name),
            "kind": _str_field(_CHAT_KIND),
            "content": _str_field(text),
            "createdAt": _ts_field(now_iso or _utc_now_iso()),
        }
    }


def payload_sender(payload: dict) -> tuple[str, str]:
    """Doc (senderId, senderName) tu payload de test/khiem chung."""
    fields = payload.get("fields", {})
    return (
        _s(fields.get("senderId", {}).get("stringValue", "")),
        _s(fields.get("senderName", {}).get("stringValue", "")),
    )


def payload_to_log_line(payload: dict) -> str:
    """Dong log AN TOAN tu payload: chi sender + kind + do dai content.

    Khong bao gio log nguyen content (co the chua thong tin nhay cam
    do caller dan vao), khong bao gio log secret — vi payload von
    khong co secret.
    """
    fields = payload.get("fields", {})
    content = _s(fields.get("content", {}).get("stringValue", ""))
    sender_id, sender_name = payload_sender(payload)
    kind = _s(fields.get("kind", {}).get("stringValue", ""))
    return (f"chat out senderId={sender_id} senderName={sender_name} "
            f"kind={kind} content_len={len(content)}")


def post_chat(transport, payload: dict) -> dict:
    """Gui payload qua `transport` FAKE trong test / that o tang ngoai.

    `transport` la callable(method, url, payload) -> dict, do caller
    cung cap. Module nay khong tu tao transport mang, khong tu goi
    Firestore. Trong unit test, transport la ham fake ghi lai payload
    va tra ve {"status": 200, "doc": "fake-doc-id"}.
    """
    return transport("POST", "documents/messages", payload)


def mentions_self(content: str, self_names) -> bool:
    """Tin co goi ten worker khong? Chi de listener tham khao.

    Ham nay KHONG duoc route_incoming() dung de loc — tin khong goi
    ten van la chat (xem ranh gioi o docstring module). No ton tai
    rieng de tang danh thuc (listener) co the hoi, neu can.
    """
    text = _s(content)
    for name in (self_names or []):
        name = _s(name).strip()
        if name and re.search(r"(?i)" + re.escape(name), text):
            return True
    return False


def _norm_kind(kind: str) -> str:
    """Lowercase + bo dau tieng Viet, de so kind he thong."""
    import unicodedata
    text = unicodedata.normalize("NFD", _s(kind).lower())
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


# Kind he thong (dang chuan hoa) — fallback khi event khong mang "type".
SYSTEM_KINDS_NORM = {"thong bao", "thong bao he thong", "system"}


def route_incoming(event: dict, self_names) -> str:
    """Dinh tuyen mot event tu listener -> "chat" | "job" | "approval" |
    "system" | "ignore".

    Thu tu quyet dinh (quan trong, dung dao):
      0. Tin cua CHINH MINH -> "ignore" (khong tu tra loi tin cua minh,
         khong tu tao job tu tin minh dang).
      1. Type cua listener (neu co) QUYET TRUOC kind/collection:
         system_event -> "system" (chi vao feed he thong, KHONG BAO GIO
         vao duong dang chat); task_event -> "job"; approval_event ->
         "approval"; message -> "chat".
      2. Khong co type thi fallback theo kind/collection cu: kind he
         thong -> "system"; approvals/kind duyet -> "approval";
         tasks/kind Giao viec/tien do -> "job".
      3. Con lai (Trao doi va cac kind chat khac) -> "chat", KE CA khi
         tin khong goi ten worker. Tin chat chung phong van doc duoc;
         viec co danh thuc worker hay khong la cua listener.
    """
    if not isinstance(event, dict):
        raise ValueError("route_incoming: event phai la dict")
    own = {_s(n).strip() for n in (self_names or []) if _s(n).strip()}
    sender_id = _event_get(event, "sender_id", "senderId")
    sender_name = _event_get(event, "sender_name", "senderName")
    if (sender_id and sender_id in own) or (sender_name and sender_name in own):
        return "ignore"
    ev_type = _event_get(event, "type")
    if ev_type == "system_event":
        return "system"
    if ev_type == "task_event":
        return "job"
    if ev_type == "approval_event":
        return "approval"
    if ev_type == "message":
        return "chat"
    collection = _event_get(event, "collection")
    kind = _event_get(event, "kind")
    if _norm_kind(kind) in SYSTEM_KINDS_NORM:
        return "system"
    if collection == "approvals" or kind in APPROVAL_KINDS:
        return "approval"
    if collection == "tasks" or kind in JOB_KINDS or kind in PROGRESS_KINDS:
        return "job"
    return "chat"
