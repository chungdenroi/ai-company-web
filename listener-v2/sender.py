#!/usr/bin/env python3
"""Tang gui that qua API cho worker phong hop (sender layer).

Day la phan con thieu cua Cong 6: worker.py / chat.py chi xay payload
va kiem tra logic (offline); file nay gui that qua Firestore REST
bang stdlib urllib — khong them dependency.

AN TOAN (doc ky):
  - Khong ham nao doc/ghi file, khong giu secret qua lan goi: idToken
    chi trong RAM cua caller; password chi di vao body sign-in.
  - Khong bao gio dua token/password vao message loi, log hay URL:
    token chi o header Authorization; loi chi mang status + thong diep
    cua server (vd "PERMISSION_DENIED"), khong kem secret.
  - 429 -> RateLimited: caller PHAI pause dai (v2: 600s), KHONG retry
    dot dot. 403/400 -> PermissionDenied/fatal: khong retry mu.
    Chi loi mang / 5xx moi retry gioi han theo worker.should_retry +
    worker.retry_delay_seconds (ham o day KHONG tu sleep de test duoc).

Su dung (runner that, khong phai file nay tu chay):
  token, _ = sign_in(API_KEY_CONG_KHAI, email, code_qua_stdin)
  post_message(PROJECT, token, build_chat_payload(own_id, own_name, text))
  patch_heartbeat(PROJECT, token, own_employee_doc_id, now_iso)
  set_work(PROJECT, token, employee_doc_id, sender_id, sender_name,
           work, task_id, progress, blocker, now_iso)
  append_task_history(PROJECT, token, task_doc_id,
                      build_task_history_entry(...))
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

IDENTITY_URL_TMPL = ("https://identitytoolkit.googleapis.com/v1/"
                      "accounts:signInWithPassword?key={key}")
FIRESTORE_BASE_TMPL = ("https://firestore.googleapis.com/v1/projects/"
                        "{project}/databases/(default)/documents")


class SendError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class RateLimited(SendError):
    """HTTP 429: caller pause dai, khong retry dot dot."""


class PermissionDenied(SendError):
    """HTTP 403: quyen bi tu choi — job chuyen blocked, khong retry mu."""


def _default_http(method, url, headers, body):
    """http mac dinh bang urllib. Tra ve (status, dict)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8") or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8") or "{}"
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = {"error": {"message": raw[:200]}}
        return exc.code, parsed
    except urllib.error.URLError as exc:
        raise SendError(f"network error: {exc.reason}")


def _server_message(body):
    if isinstance(body, dict):
        err = body.get("error", {})
        if isinstance(err, dict):
            return err.get("message", "unknown")
        return str(err)
    return "unknown"


def classify_status(status):
    """429 -> 'rate_limited'; 403 -> 'denied'; 5xx/None -> 'retryable';
    400/404/409 -> 'fatal'; 2xx -> 'ok'."""
    if status is None:
        return "retryable"
    if 200 <= status < 300:
        return "ok"
    if status == 429:
        return "rate_limited"
    if status == 403:
        return "denied"
    if status in (400, 404, 409):
        return "fatal"
    if status >= 500:
        return "retryable"
    return "fatal"


def _check(status, body, what):
    kind = classify_status(status)
    if kind == "ok":
        return body
    if kind == "rate_limited":
        raise RateLimited(f"{what}: rate limited (429)", status=status)
    if kind == "denied":
        raise PermissionDenied(
            f"{what}: denied ({_server_message(body)})", status=status)
    raise SendError(f"{what}: failed ({_server_message(body)})",
                    status=status)


def sign_in(api_key, email, password, http=None):
    """Sign-in IdentityToolkit. Tra ve (id_token, expires_in_secs).
    api_key la PUBLIC web-app key (nam trong config web), KHONG phai
    secret. Loi khong bao gio kem password."""
    http = http or _default_http
    url = IDENTITY_URL_TMPL.format(key=api_key)
    status, body = http("POST", url, {},
                        {"email": email, "password": password,
                         "returnSecureToken": True})
    body = _check(status, body, "sign-in")
    token = body.get("idToken", "")
    if not token:
        raise SendError("sign-in: no idToken in response", status=status)
    try:
        expires = int(body.get("expiresIn", "3600"))
    except ValueError:
        expires = 3600
    return token, expires


def _auth_headers(id_token):
    return {"Authorization": f"Bearer {id_token}"}


def _doc_base(project):
    return FIRESTORE_BASE_TMPL.format(project=project)


def post_document(project, id_token, collection, fields_payload, http=None):
    """POST documents/<collection>. fields_payload dang {"fields": ...}
    (vd build_chat_payload / build_decision_log_entry). Tra ve ten doc."""
    http = http or _default_http
    url = f"{_doc_base(project)}/{collection}"
    status, body = http("POST", url, _auth_headers(id_token),
                        fields_payload)
    body = _check(status, body, f"post {collection}")
    return body.get("name", "")


def post_message(project, id_token, chat_payload, http=None):
    """POST 1 tin chat (payload tu chat.build_chat_payload)."""
    return post_document(project, id_token, "messages", chat_payload,
                         http=http)


def patch_heartbeat(project, id_token, employee_doc_id, now_iso, http=None):
    """PATCH lastCheckAt cua CHINH doc nhan vien do. Chi goi ngay sau
    hoat dong that (da dang chat / ack / hoan thanh job) — xem
    worker.build_heartbeat_payload (throttle 5 phut)."""
    http = http or _default_http
    url = (f"{_doc_base(project)}/employees/{employee_doc_id}"
           f"?updateMask.fieldPaths=lastCheckAt")
    body = {"fields": {"lastCheckAt": {"timestampValue": now_iso}}}
    status, resp = http("PATCH", url, _auth_headers(id_token), body)
    _check(status, resp, "patch heartbeat")
    return True


def _utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _patch_fields(project, id_token, collection, doc_id, fields, http):
    """PATCH 1 doc voi updateMask cho cac field. PATCH tao doc neu
    chua co (theo semantics Firestore REST). Tra ve True."""
    http = http or _default_http
    masks = "&".join(f"updateMask.fieldPaths={k}" for k in fields)
    url = f"{_doc_base(project)}/{collection}/{doc_id}?{masks}"
    body = {"fields": fields}
    status, resp = http("PATCH", url, _auth_headers(id_token), body)
    _check(status, resp, f"patch {collection}/{doc_id}")
    return True


def set_work(project, id_token, employee_doc_id, sender_id, sender_name,
             work, task_id="", progress="", blocker="", now_iso=None,
             http=None):
    """Gop 3 viec 1 lenh khi bat dau/doi viec (Pha 1) — goi ngay, dung
    cho toi khi xong viec moi doi:
      1. PATCH presence/<employee_doc_id>: status, currentWork,
         taskId, progress, blocker, lastSeen.
      2. PATCH employees/<employee_doc_id>: currentWork (the web
         hien tai doc truong nay nen doi the ngay).
      3. POST messages: tin trang thai, kind 'Cap nhat tien do'.
    employee_doc_id rong -> dung sender_id (doc nhan vien thuong key
    theo sender; neu doc cua ban co id khac thi truyen rieng).
    Loi o buoc nao thi dung o buoc do (429 -> RateLimited, caller
    pause dai; khong dang tin trang thai khi presence chua ghi duoc).
    Tra ve dict {presence, employee, message}."""
    doc_id = (employee_doc_id or "").strip() or (sender_id or "").strip()
    if not doc_id:
        raise ValueError("set_work: employee_doc_id/sender_id rong — "
                         "khong biet ghi presence cho ai")
    if not (sender_id or "").strip():
        raise ValueError("set_work: sender_id rong — "
                         "khong dang tin khong danh tinh")
    if not (sender_name or "").strip():
        raise ValueError("set_work: sender_name rong — "
                         "khong dang tin khong danh tinh")
    if not (work or "").strip():
        raise ValueError("set_work: work rong — "
                         "khong co viec gi de bao")
    now = now_iso or _utc_now_iso()
    presence_fields = {
        "status": {"stringValue": "Đang làm"},
        "currentWork": {"stringValue": work},
        "taskId": {"stringValue": task_id or ""},
        "progress": {"stringValue": progress or ""},
        "blocker": {"stringValue": blocker or ""},
        "lastSeen": {"timestampValue": now},
    }
    _patch_fields(project, id_token, "presence", doc_id,
                  presence_fields, http)
    _patch_fields(project, id_token, "employees", doc_id,
                  {"currentWork": {"stringValue": work}}, http)
    parts = [f"Đang làm: {work}"]
    if task_id:
        parts.append(f"Việc: {task_id}")
    if progress:
        parts.append(f"Tiến độ: {progress}")
    if blocker:
        parts.append(f"Kẹt: {blocker}")
    payload = {"fields": {
        "senderId": {"stringValue": sender_id},
        "senderName": {"stringValue": sender_name},
        "kind": {"stringValue": "Cập nhật tiến độ"},
        "content": {"stringValue": " — ".join(parts)},
        "createdAt": {"timestampValue": now},
    }}
    name = post_document(project, id_token, "messages", payload,
                         http=http)
    return {"presence": True, "employee": True, "message": name}


def append_task_history(project, id_token, task_doc_id, history_entry,
                        http=None):
    """Ghi them 1 muc vao tasks/<id>.history bang FieldTransform
    appendMissingElements (KHONG ghi de toan bo history) + dat
    updatedAt = REQUEST_TIME. history_entry dang {"fields": ...}
    (vd worker.build_task_history_entry)."""
    http = http or _default_http
    doc_name = f"{_doc_base(project)}/tasks/{task_doc_id}"
    body = {"writes": [{"transform": {
        "document": doc_name,
        "fieldTransforms": [
            {"fieldPath": "history",
             "appendMissingElements": {"values": [
                 {"mapValue": {"fields": history_entry.get("fields", {})}}]}},
            {"fieldPath": "updatedAt",
             "setToServerValue": "REQUEST_TIME"},
        ]}}]}
    url = f"{_doc_base(project)}:commit"
    status, resp = http("POST", url, _auth_headers(id_token), body)
    _check(status, resp, "append task history")
    return True
