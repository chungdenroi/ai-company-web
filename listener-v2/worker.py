#!/usr/bin/env python3
"""Vong doi job + duyet + heartbeat cho worker phong hop Enteesee.

OFFLINE / KHONG GUI THAT:
  Module nay CHI xay payload, kiem tra chuyen trang thai, kiem tra
  duyet, tinh throttle heartbeat. No KHONG goi mang, KHONG dang nhap,
  KHONG doc/ghi Firestore live, KHONG nhan mat khau/token. Mọi ham
  `build_*` chi tra ve dict payload — tang gui that (ngoai module
  nay) moi POST/PATCH khi nguoi van hanh cho phep, mat khau qua stdin.

QUY TAC CUNG — MAY TRANG THAI JOB (CHI cho viec that):
  pending -> acknowledged -> in_progress -> completed | blocked | failed
  blocked -> in_progress (tiep tuc) | cancelled | failed
  acknowledged -> in_progress | blocked | cancelled
  pending -> acknowledged | cancelled
  completed / failed / cancelled la TRANG THAI CUOI (khong chuyen tiep).

  Chat tu do KHONG di qua may nay. Khong co chuyen mot tin chat phai
  "acknowledged" roi moi "completed". Neu ai do dua chat vao may job
  thi do la loi thiet ke, khong phai tinh nang.

  KHONG TU CHUYEN COMPLETED CHI VI DA NHAN LENH: completed bat buoc
  co evidence (dau ra kiem tra duoc: van ban ket qua / link / doc id).
  Thieu evidence -> validation tu choi, job o nguyen trang thai cu.
  blocked / failed bat buoc co reason + thoi gian. Trang thai loi
  duoc ghi ben (state dict) thay vi danh dau thanh cong gia.

IDEMPOTENCY:
  Key = (job_id, action). Retry cung key khong ap dung trung: lan 2
  tra ve trang thai hien tai + applied=False, khong them lich su.
  Key khac nhau (vd block roi resume) thi ap dung binh thuong.

HEARTBEAT (PRESENCE):
  build_heartbeat_payload() chi tra payload khi da du 5 phut tu lan
  heartbeat truoc — chong ghi don (toi da 1 lan / 5 phut / worker).
  RANH GIOI QUAN TRONG: ham nay la PURE THROTTLE, no khong biet
  worker co hoat dong that hay khong. Caller CHI DUOC goi ham nay ngay
  sau mot hoat dong that (da dang chat, da ack job, da hoan thanh
  job) — TUYET DOI khong goi theo moi event stream di qua.
  Ve Rules: Rules phai cho phep ghi doc cua CHINH MINH thi heartbeat
  moi ghi duoc. Neu Rules tu choi, hoat dong that (tin da dang, job
  da ack) VAN la bang chung hoat dong — heartbeat chi la tin hieu
  phu, khong phai bang chung duy nhat. Test plan luc chay that phai
  kiem tra CA 2 truong hop: Rules cho phep -> lastCheckAt doi;
  Rules tu choi -> tin/job van ghi duoc, chi heartbeat loi, va loi
  do phai duoc ghi lai chu khong duoc gia vo thanh cong.

DUYET (VALIDATION, KHONG PHAI ENFORCEMENT SERVER):
  validate_approval() chi kiem tra truoc khi gui. Server/Rules moi la
  noi chan cuoi cung; ham nay giup worker khong gui mot quyet dinh
  thieu sot roi tuong la xong.
"""

from __future__ import annotations

import random
from datetime import datetime, timezone

# ---------------------------------------------------------------- states

STATES = ("pending", "acknowledged", "in_progress", "completed",
          "blocked", "failed", "cancelled")
TERMINAL = frozenset({"completed", "failed", "cancelled"})

# (trang thai hien tai) -> {action: trang thai dich}
TRANSITIONS = {
    "pending": {"acknowledge": "acknowledged", "cancel": "cancelled"},
    "acknowledged": {"start": "in_progress", "block": "blocked",
                     "cancel": "cancelled"},
    "in_progress": {"complete": "completed", "block": "blocked",
                    "fail": "failed", "cancel": "cancelled"},
    "blocked": {"resume": "in_progress", "fail": "failed",
                "cancel": "cancelled"},
    "completed": {},
    "failed": {},
    "cancelled": {},
}

# Action nao bat buoc evidence / reason.
NEEDS_EVIDENCE = {"complete"}
NEEDS_REASON = {"block", "fail"}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _s(value) -> str:
    if value is None:
        return ""
    return str(value)


def _parse_iso(value: str) -> datetime:
    text = _s(value).strip()
    if not text:
        raise ValueError("thoi gian rong")
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _str_field(value: str) -> dict:
    return {"stringValue": value}


def _ts_field(value: str) -> dict:
    return {"timestampValue": value}


# ---------------------------------------------------------------- evidence

def validate_evidence(evidence) -> tuple[bool, str]:
    """Evidence phai la dau ra KIEM TRA DUOC, khong phai loi noi suong.

    Chap nhan: chuoi khong rong (van ban ket qua / link / doc id), hoac
    dict co it nhat mot trong cac truong text/link/doc_id/url khong rong.
    Tu choi: None, "", "done", "ok", "xong" don thuan — vi khong kiem
    tra duoc. (Chuoi "done" kem link van duoc neu co link that.)
    """
    if evidence is None:
        return False, "thieu evidence: completed can dau ra kiem tra duoc"
    if isinstance(evidence, str):
        text = evidence.strip()
        if not text:
            return False, "thieu evidence: chuoi rong"
        if text.lower() in {"done", "ok", "xong", "completed", "finish"}:
            return False, ("evidence chi la loi noi suong (%r), can van ban "
                           "ket qua / link / doc id" % text)
        return True, ""
    if isinstance(evidence, dict):
        for key in ("text", "link", "doc_id", "url", "result"):
            if _s(evidence.get(key)).strip():
                return True, ""
        return False, ("thieu evidence: dict khong co text/link/doc_id/url "
                       "nao khong rong")
    return False, "evidence sai kieu: can chuoi hoac dict"


def validate_reason(reason) -> tuple[bool, str]:
    if not _s(reason).strip():
        return False, "thieu reason: blocked/failed bat buoc co ly do"
    return True, ""


# ---------------------------------------------------------------- job state

def new_job(job_id: str, now_iso: str | None = None) -> dict:
    """Khoi tao state dict cho mot job moi (trang thai pending)."""
    if not _s(job_id).strip():
        raise ValueError("new_job: job_id rong")
    now = now_iso or _utc_now_iso()
    return {"job_id": _s(job_id), "state": "pending",
            "evidence": None, "reason": None,
            "created_at": now, "updated_at": now, "history": []}


def transition(job: dict, action: str, evidence=None, reason=None,
               now_iso: str | None = None) -> dict:
    """Chuyen trang thai (khong idempotency — xem apply_action).

    Tra ve state dict MOI (khong sua dict cu). Loi -> ValueError voi
    ly do ro rang, job o nguyen trang thai cu (caller giu dict cu).
    """
    current = job["state"]
    allowed = TRANSITIONS.get(current, {})
    if action not in allowed:
        raise ValueError(
            f"chuyen trang thai khong hop le: {current} --{action}--> ? "
            f"(cho phep tu {current}: {sorted(allowed) or 'khong co — '
            'trang thai cuoi'})")
    if action in NEEDS_EVIDENCE:
        ok, why = validate_evidence(evidence)
        if not ok:
            raise ValueError(f"tu choi complete: {why}")
    if action in NEEDS_REASON:
        ok, why = validate_reason(reason)
        if not ok:
            raise ValueError(f"tu choi {action}: {why}")
    nxt = allowed[action]
    now = now_iso or _utc_now_iso()
    new = dict(job)
    new["state"] = nxt
    new["updated_at"] = now
    if action in NEEDS_EVIDENCE:
        new["evidence"] = evidence
    if action in NEEDS_REASON:
        new["reason"] = _s(reason).strip()
    new["history"] = list(job.get("history", [])) + [{
        "action": action, "from": current, "to": nxt, "at": now,
        "evidence": evidence if action in NEEDS_EVIDENCE else None,
        "reason": _s(reason).strip() if action in NEEDS_REASON else None,
    }]
    return new


class JobStore:
    """State ben dang dict: jobs + idempotency keys da ap dung.

    Day la lop ghi ben o muc ung dung (co the dump ra JSON de giu qua
    restart). No khong phai database, khong tu dong luu file — caller
    tu dump/load khi can (dump_state / load_state).
    """

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.applied_keys: set[str] = set()

    def get_or_create(self, job_id: str, now_iso: str | None = None) -> dict:
        if job_id not in self.jobs:
            self.jobs[job_id] = new_job(job_id, now_iso=now_iso)
        return self.jobs[job_id]

    def apply_action(self, job_id: str, action: str, evidence=None,
                     reason=None, now_iso: str | None = None,
                     delivery_id: str | None = None):
        """Ap dung action voi idempotency key mac dinh (job_id, action).

        Tra ve (state, applied). Neu key da ap dung roi -> (state hien
        tai, False), KHONG them lich su, KHONG doi trang thai lan 2.
        GIOI HAN CUA KEY MAC DINH (doc ky): key (job_id, action) chan
        retry trung cua CUNG mot lan gui, nhung no cung chan mot hanh
        dong that moi cung action sau do (vd block -> resume -> block
        lai). Vi vay: retry cung lan gui thi goi khong delivery_id;
        hanh dong that moi thi truyen delivery_id rieng (vd id cua
        event gay ra no) de key thanh (job_id, action, delivery_id),
        hoac dung transition() truc tiep. Xem README-worker.md.
        """
        key = f"{job_id}::{action}" if not delivery_id \
            else f"{job_id}::{action}::{delivery_id}"
        current = self.get_or_create(job_id, now_iso=now_iso)
        if key in self.applied_keys:
            return current, False
        new = transition(current, action, evidence=evidence, reason=reason,
                         now_iso=now_iso)
        self.jobs[job_id] = new
        self.applied_keys.add(key)
        return new, True

    def dump_state(self) -> dict:
        return {"jobs": self.jobs,
                "applied_keys": sorted(self.applied_keys)}

    @classmethod
    def load_state(cls, data: dict) -> "JobStore":
        store = cls()
        store.jobs = dict(data.get("jobs", {}))
        store.applied_keys = set(data.get("applied_keys", []))
        return store


# ------------------------------------------------------- decision dedup
MAX_DECIDED_IDS = 1000


def should_process_decision(decided_ids, doc_id: str, decided_at: str) -> bool:
    """True neu quyet dinh duyet nay CHUA duoc xu ly.

    Hai stream approvals (createdAt va decidedAt) co the bao cung mot
    quyet dinh: createdAt-MODIFIED khi duyet + decidedAt-stream khi
    decidedAt duoc set. Ca hai deu mang decidedAt; worker chi thong bao
    1 lan cho moi doc_id da duyet. decided_ids la tap doc_id da xu ly
    (caller them doc_id vao sau khi xu ly). Thieu doc_id hoac
    decided_at -> False (khong phai quyet dinh hoan chinh).
    """
    if not _s(doc_id) or not _s(decided_at):
        return False
    return _s(doc_id) not in {_s(d) for d in (decided_ids or [])}


def trim_decided_ids(decided_ids, cap: int = MAX_DECIDED_IDS) -> list:
    """Giu cap doc_id (theo thu tu chuoi — chi la gioi han bo nho; tap
    day khong gay mat thong bao vi checkpoint + emitted_ids cua
    listener van chan replay)."""
    ids = sorted({_s(d) for d in (decided_ids or []) if _s(d)})
    return ids[-cap:] if cap > 0 else []


# ---------------------------------------------------------------- retry

def retry_delay_seconds(attempt: int, base_seconds: float = 5.0,
                        cap_seconds: float = 300.0,
                        jitter_fraction: float = 0.5,
                        rng=None) -> float:
    """Backoff mu + jitter: delay nam trong [base*2^attempt*(1-j), cap].

    attempt bat dau tu 0 (lan retry dau). Ham khong sleep — caller tu
    sleep theo gia tri tra ve, de test offline duoc.
    """
    if attempt < 0:
        raise ValueError("attempt khong am")
    if not (0 <= jitter_fraction < 1):
        raise ValueError("jitter_fraction phai trong [0, 1)")
    raw = base_seconds * (2 ** attempt)
    jitter = (rng or random).uniform(0, jitter_fraction) if jitter_fraction else 0
    return min(cap_seconds, raw * (1 - jitter)) if raw < cap_seconds else cap_seconds


def should_retry(attempt: int, max_retries: int = 3) -> bool:
    """Con duoc retry khong? attempt = so lan da thu that bai."""
    return attempt < max_retries


# ---------------------------------------------------------------- payloads

def build_task_history_entry(job_id: str, transition_name: str,
                             evidence=None, reason=None,
                             now_iso: str | None = None) -> dict:
    """Xay payload lich su task — CHI XAY, KHONG GUI THAT.

    `transition_name` la ten chuyen doi, vd "pending->acknowledged"
    hoac action "complete". Caller tu chon cach ghi; ham khong tu
    suy dien trang thai.
    """
    if not _s(job_id).strip():
        raise ValueError("build_task_history_entry: job_id rong")
    fields = {
        "jobId": _str_field(_s(job_id)),
        "transition": _str_field(_s(transition_name)),
        "createdAt": _ts_field(now_iso or _utc_now_iso()),
    }
    if evidence is not None:
        fields["evidence"] = _str_field(_s(evidence) if not isinstance(evidence, dict)
                                        else str(evidence))
    if reason is not None:
        fields["reason"] = _str_field(_s(reason))
    return {"fields": fields}


def build_decision_log_entry(decision_id: str, subject: str,
                             approver_id: str, approver_name: str,
                             verdict: str, reason: str, evidence=None,
                             items=None, now_iso: str | None = None) -> dict:
    """Xay payload decisions — CHI XAY, KHONG GUI THAT.

    Khong tu dong hop le hoa: hay chay validate_approval() truoc khi
    gui payload nay that. Payload chi ghi lai nhung gi caller dua.
    """
    if not _s(decision_id).strip():
        raise ValueError("build_decision_log_entry: decision_id rong")
    fields = {
        "decisionId": _str_field(_s(decision_id)),
        "subject": _str_field(_s(subject)),
        "approverId": _str_field(_s(approver_id)),
        "approverName": _str_field(_s(approver_name)),
        "verdict": _str_field(_s(verdict)),
        "reason": _str_field(_s(reason)),
        "createdAt": _ts_field(now_iso or _utc_now_iso()),
    }
    if evidence is not None:
        fields["evidence"] = _str_field(_s(evidence) if not isinstance(evidence, dict)
                                        else str(evidence))
    if items is not None:
        fields["items"] = _str_field(str(items))
    return {"fields": fields}


# ---------------------------------------------------------------- approval

def validate_approval(decision: dict) -> dict:
    """Kiem tra mot quyet dinh duyet. Tra ve {"ok": bool, "errors": [...]}.

    Quy tac (thieu bat ky muc nao -> tu choi voi ly do ro rang):
      1. Co reason bat buoc, khong rong.
      2. Co evidence (dau ra kiem tra duoc, theo validate_evidence).
      3. Khong tu phe duyet chinh minh: approver_id != requester_id /
         author_id / owner_id (neu co); approver_name != requester_name
         khi khong co id de doi chieu.
      4. Khong duyet tat ca vo dieu kien: neu verdict/flag noi "duyet
         tat ca" hoac scope="all" ma khong liet ke items thi tu choi.
         Duyet lo PHAI liet ke tung muc + ket qua rieng cho tung muc.
      5. Co verdict hop le (approve / reject / request_changes).
    """
    errors: list[str] = []
    if not isinstance(decision, dict):
        return {"ok": False, "errors": ["decision phai la dict"]}
    if not _s(decision.get("reason")).strip():
        errors.append("thieu reason: duyet bat buoc co ly do")
    ok_ev, why_ev = validate_evidence(decision.get("evidence"))
    if not ok_ev:
        errors.append(f"thieu evidence: {why_ev}")
    approver_id = _s(decision.get("approver_id") or decision.get("approverId"))
    for owner_key in ("requester_id", "author_id", "owner_id",
                      "requesterId", "authorId", "ownerId"):
        owner = _s(decision.get(owner_key))
        if approver_id and owner and approver_id == owner:
            errors.append(f"tu phe duyet chinh minh: approver ({approver_id}) "
                          f"trung {owner_key} ({owner})")
    approver_name = _s(decision.get("approver_name") or decision.get("approverName"))
    requester_name = _s(decision.get("requester_name") or decision.get("requesterName"))
    if not approver_id and approver_name and requester_name \
            and approver_name == requester_name:
        errors.append("tu phe duyet chinh minh: approver_name trung requester_name")
    verdict = _s(decision.get("verdict")).strip().lower()
    if verdict not in {"approve", "reject", "request_changes"}:
        errors.append(f"verdict khong hop le: {verdict!r} "
                      "(can approve / reject / request_changes)")
    blanket = bool(decision.get("approve_all") or decision.get("approveAll")
                   or decision.get("blanket"))
    if verdict in {"approve_all", "approve_everything"}:
        blanket = True
    if _s(decision.get("scope")).strip().lower() == "all":
        blanket = True
    items = decision.get("items")
    if blanket and not items:
        errors.append("duyet tat ca vo dieu kien: duyet lo phai liet ke "
                      "tung muc + ket qua rieng, khong duyet kieu 'all'")
    if items is not None:
        if not isinstance(items, list) or not items:
            errors.append("items phai la danh sach khong rong khi duyet lo")
        else:
            for i, item in enumerate(items):
                if not isinstance(item, dict):
                    errors.append(f"items[{i}] phai la dict (id + ket qua rieng)")
                    continue
                item_id = _s(item.get("id") or item.get("item_id"))
                result = _s(item.get("result") or item.get("verdict"))
                if not item_id:
                    errors.append(f"items[{i}] thieu id")
                if result.strip().lower() not in {"approve", "reject", "request_changes"}:
                    errors.append(f"items[{i}] thieu ket qua rieng hop le")
    return {"ok": not errors, "errors": errors}


# ---------------------------------------------------------------- heartbeat

HEARTBEAT_MIN_INTERVAL_SECONDS = 5 * 60


def heartbeat_allowed(now_iso: str, last_heartbeat_iso) -> bool:
    """Du 5 phut tu lan heartbeat truoc chua? Chua co lan truoc -> True."""
    if not _s(last_heartbeat_iso).strip():
        return True
    try:
        delta = (_parse_iso(now_iso) - _parse_iso(_s(last_heartbeat_iso))).total_seconds()
    except ValueError:
        # Timestamp cu loi dinh dang -> cho phep ghi lai de phuc hoi,
        # caller ghi log canh bao chu khong gia vo thanh cong.
        return True
    return delta >= HEARTBEAT_MIN_INTERVAL_SECONDS


def build_heartbeat_payload(own_employee_doc_id: str, now_iso: str,
                            last_heartbeat_iso) -> dict | None:
    """Xay payload cap nhat lastCheckAt cua CHINH doc nhan vien do.

    Tra ve None neu chua du 5 phut tu lan heartbeat truoc (chong ghi
    don: toi da 1 lan / 5 phut / worker).
    Tra ve {"doc_id", "fields"} de tang gui that PATCH dung doc do —
    KHONG BAO GIO tra ve doc cua nguoi khac, vi ham chi nhan doc id
    cua chinh worker (own_employee_doc_id).

    LUY Y CALLER (ghi lai lan nua vi de quen): CHI GOI ham nay ngay
    sau hoat dong that (da dang chat / ack job / hoan thanh job).
    Khong goi theo moi event stream. Neu Rules tu choi ghi (doc cua
    minh nhung Rules chua mo), loi do phai duoc ghi lai; hoat dong
    that truoc do (tin da dang, job da ack) van la bang chung hoat
    dong, khong duoc bao cao la "worker khong hoat dong" chi vi
    heartbeat loi. Test plan chay that phai kiem tra ca 2 truong hop.
    """
    doc_id = _s(own_employee_doc_id).strip()
    if not doc_id:
        raise ValueError("build_heartbeat_payload: own_employee_doc_id rong — "
                         "khong duoc heartbeat vao doc khong ro chu")
    if not heartbeat_allowed(now_iso, last_heartbeat_iso):
        return None
    return {"doc_id": doc_id,
            "fields": {"lastCheckAt": _ts_field(now_iso)}}
