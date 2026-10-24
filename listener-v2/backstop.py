#!/usr/bin/env python3
"""Doi soat backstop-only cho worker phong hop Enteesee.

CHI BAO CAO, KHONG PHAT LAI — doc ky truoc khi sua file nay:
  - reconcile() chi doc danh sach event + danh sach id da xu ly, tra
    ve JSON report. No KHONG gui tin, KHONG ghi Firestore, KHONG goi
    mang, KHONG co che do ghi/phat lai trong ban nay.
  - Mac dinh la dry-run, va day cung la che do DUY NHAT: khong co
    tham so nao bat "replay". Ai muon hanh dong thi doc report roi
    quyet rieng, ngoai module nay.
  - Su kien da xu ly KHONG BAO GIO xuat hien lai duoi dang moi:
    neu id cua no nam trong processed_ids, no vao already_processed,
    khong bao gio vao missed — ke ca khi event lap lai trong dau vao.

Dinh nghia missed:
  missed = event nam TRONG cua so [window_start, window_end] (so sanh
  theo thoi gian, khong theo chuoi) VA chua co trong processed_ids
  VA chua qua han xac nhan. "Qua han xac nhan" chi ap dung khi caller
  truyen ca now_iso + ack_grace_minutes: event cu hon grace ke tu ts
  cua no thi coi la het han (khong con la "missed" nua, ma la van de
  qua han rieng, khong do backstop nay bao cao lai). Neu khong truyen
  2 tham so do, moi event trong cua so chua xu ly deu la missed.

Event dict chap nhan ca key cua listener (event_id, ts, doc_id) va
key Firestore (id, createdAt).
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta


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


def _event_id(event: dict) -> str:
    for key in ("event_id", "doc_id", "id"):
        if event.get(key) not in (None, ""):
            return _s(event[key])
    return ""


def _event_ts(event: dict) -> str:
    for key in ("ts", "createdAt"):
        if event.get(key) not in (None, ""):
            return _s(event[key])
    return ""


def reconcile(window_start: str, window_end: str, events,
              processed_ids, now_iso: str | None = None,
              ack_grace_minutes: float | None = None) -> dict:
    """Doi soat mot cua so. Chi tra report, khong co tac dung phu.

    Tra ve:
      {"window": {"start", "end"},
       "missed": [event_id, ...],          # trong cua so, chua xu ly,
                                           # chua qua han xac nhan
       "already_processed": [event_id, ...],
       "total_in_window": int,             # so event KHAC NHAU trong cua so
       "duplicates_skipped": int,          # so ban lap lai bi loai
       "dry_run": True}                    # luon True: khong co replay
    Thu tu: theo (ts, event_id) de report on dinh, lap lai duoc.
    """
    start = _parse_iso(window_start)
    end = _parse_iso(window_end)
    if end < start:
        raise ValueError("reconcile: window_end truoc window_start")
    now = _parse_iso(now_iso) if now_iso else None
    grace = None
    if ack_grace_minutes is not None:
        if now is None:
            raise ValueError("reconcile: ack_grace_minutes can kem now_iso")
        grace = timedelta(minutes=float(ack_grace_minutes))

    processed = {_s(p) for p in (processed_ids or [])}
    seen: dict[str, dict] = {}  # event_id -> event (ban dau tien thang)
    duplicates_skipped = 0
    for event in (events or []):
        if not isinstance(event, dict):
            continue
        eid = _event_id(event)
        if not eid:
            continue  # event khong co id thi khong doi soat duoc — bo qua, khong doan
        ts_raw = _event_ts(event)
        if not ts_raw:
            continue
        try:
            ts = _parse_iso(ts_raw)
        except ValueError:
            continue
        if not (start <= ts <= end):
            continue  # ngoai cua so: khong tinh, du xu ly hay chua
        if eid in seen:
            duplicates_skipped += 1
            continue  # trung lap dau vao: khong lam sai report
        seen[eid] = event

    missed: list[str] = []
    already: list[str] = []
    for eid, event in sorted(seen.items(),
                             key=lambda kv: (_parse_iso(_event_ts(kv[1])), kv[0])):
        if eid in processed:
            already.append(eid)  # da xu ly: khong bao gio thanh missed
            continue
        if now is not None and grace is not None:
            if now - _parse_iso(_event_ts(event)) > grace:
                continue  # qua han xac nhan: khong bao cao la missed
        missed.append(eid)
    return {
        "window": {"start": window_start, "end": window_end},
        "missed": missed,
        "already_processed": already,
        "total_in_window": len(seen),
        "duplicates_skipped": duplicates_skipped,
        "dry_run": True,
    }
