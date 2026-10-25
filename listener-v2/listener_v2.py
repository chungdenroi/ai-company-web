#!/usr/bin/env python3
"""Realtime listener v2 for the Enteesee meeting room (Firestore Listen).

OFFLINE-BUILD NOTE: this file is pure logic plus a thin gRPC adapter.
Every detection / dedup / backoff / checkpoint decision below is a pure
function or a local-file operation, so it is unit-testable with NO
network and NO access code (see test_listener_v2.py). The gRPC adapter
at the bottom only runs when the operator explicitly starts the worker
with their own code on stdin.

Verified v1 patterns PRESERVED from ~/workspace/ai-company/listener/
listener.py (read before writing this file; v1 itself is NOT modified):
  (1) Listen ONLY via gRPC (google-cloud-firestore on_snapshot).
      A plain REST POST to :listen is rejected by Google with HTTP 400
      for every body -- verified on v1. Never "restore" a REST listen.
  (2) Validate the code with ONE throwaway sign-in, then DISCARD the
      token and let the library refresh lazily when the stream opens.
      NEVER call creds.refresh() manually before creating the Client:
      v1 bisection proved that breaks the Listen stream (0 snapshots,
      CPU spin), while lazy refresh is healthy.
  (3) The access code comes ONLY from stdin (line 1) or
      --credential-file, is kept ONLY in process memory, and is NEVER
      put in argv, logs, or any file.
  (4) Run with a venv interpreter (.venv/bin/python) that has
      google-cloud-firestore installed; honour the egress-proxy CA
      bundle when present.
  (5) State is written atomically (temp file + fsync + os.replace);
      the event log is append-only with fsync per write.

What v2 changes vs v1 (approved architecture: ONE worker per account,
each worker holding its OWN stream; NO central service pushes a
notification into somebody else's account):
  - Three bounded streams instead of one: messages, tasks, approvals.
    Each stream starts from THIS worker's OWN per-collection checkpoint
    (its own state file), never from the guard's watermark and never
    from the beginning of history. First run with no state starts at
    "now minus 5 minutes".
  - Two parallel event streams, classified per document:
      message       = free chat (collection messages, ordinary kinds)
      task_event    = a task assigned / changed (collection tasks)
      approval_event= an approval requested / decided (approvals)
      system_event  = a system broadcast (messages of kind
                      "Thông báo" / "Thông báo hệ thống" / "system")
    Every event carries event_id = collection + ":" + docId, plus
    ":" + updateTime when a MODIFIED change is re-delivered.
  - "Notified" is NOT "accepted". This listener only WRITES the local
    event log. Accepting a task ("đã nhận việc") is a SEPARATE
    downstream job of the worker owner; it is never done here and
    nothing is ever written back to Firestore on detection.
  - Quota-safe retry: exponential backoff with jitter, a hard retry
    cap, and a circuit breaker. After N consecutive failures the
    worker writes state "failed" and EXITS for a human to look at --
    it never loops forever and never re-reads full history. A 429 /
    RESOURCE_EXHAUSTED gets a LONG backoff and no burst retry.

Schema assumptions (read from the live web app's app.js, NOT verified
against a live stream -- see README "chưa kiểm chứng live"):
  - messages: createdAt (server timestamp). Query: createdAt >= start.
  - tasks: createdAt + updatedAt (status changes set updatedAt).
    Query: updatedAt >= start, so an old task updated after a restart
    IS still delivered.
  - approvals: createdAt + requestedAt + decidedAt, NO updatedAt field
    in the app code. Query: createdAt >= start. Consequence: an
    approval created BEFORE a restart whose decision lands AFTER the
    restart is NOT delivered by this stream (its createdAt predates
    the query window). The guard poll remains the backstop for that
    corner; see README.

Exit codes: 0 clean shutdown, 3 sign-in failed, 5 watch dead (monitor
saw is_active False 3x -- watchdog restarts), 6 google-cloud-firestore
not installed for this interpreter, 7 circuit breaker tripped or
restart loop detected (needs a human; watchdog must NOT blindly
restart a state="failed" worker, see README), 42 no credential
supplied, 1 other fatal error.

Usage (fresh install, own account, own code -- see README):
    python3 -m venv .venv && .venv/bin/pip install google-cloud-firestore
    printf '%s\n' "$CODE" | .venv/bin/python listener_v2.py \\
        --mode staff --email you@aicompany.app --self-names "Hùng,Hung"

Health check (no network, no credential, reads the status file only):
    .venv/bin/python listener_v2.py health-check --status-file \\
        listener_v2.status.json
"""

import argparse
import json
import os
import random
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from datetime import datetime, timezone, timedelta

try:
    from google.auth.credentials import Credentials as _GoogleCredentials
    from google.cloud import firestore as _firestore
    from google.cloud.firestore_v1.base_query import FieldFilter
    _HAVE_FIRESTORE = True
except Exception:
    _HAVE_FIRESTORE = False

PROJECT = "ai-company-a51da"
CHAIRMAN_SENDER_ID = "chung"
FIREBASE_TOKEN_TTL_SECS = 50 * 60
# Egress proxy re-signs TLS with its own CA; grpc must trust it.
PROXY_CA_BUNDLE = "/run/hatch/egress-tls/ca-bundle.pem"

# Deliberately NOT embedded here: v2 takes the Firebase web API key
# (a public identifier already shipped in the web app's config, NOT
# the access code) from the FIREBASE_API_KEY environment variable.
# The access code itself is never stored anywhere; see read_credential.
IDENTITY_URL_TMPL = ("https://identitytoolkit.googleapis.com/v1"
                     "/accounts:signInWithPassword?key={key}")

# ---- tunables (also documented in README) ----
MAX_EMITTED_IDS = 1000
DEFAULT_LOOKBACK_MINUTES = 5
MONITOR_INTERVAL_SECS = 60
DEAD_STREAK_LIMIT = 3
HEARTBEAT_QUIET_SECS = 300
MAX_CONSECUTIVE_FAILURES = 5   # circuit breaker trip point
MAX_CONSECUTIVE_RESTARTS = 5   # restart-loop trip point
RATE_LIMIT_BACKOFF_SECS = 600  # pause after a 429 before any resume
SYSTEM_KINDS = {"thong bao", "thong bao he thong", "system"}


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


# ---------------------------------------------------------------- pure
# These functions never touch the network, credentials, or disk, and
# are the whole surface unit-tested offline in test_listener_v2.py.

def normalize_text(s):
    """Lowercase + strip diacritics (incl. Vietnamese d/D)."""
    if not s:
        return ""
    s = s.replace("đ", "d").replace("Đ", "D")
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    return s.lower().strip()


def extract_mentions(content):
    """Normalized tokens following @ in content."""
    if not content:
        return []
    raw = re.findall(r"@([^\s@,;:!?()\[\]\"'.]+)", content)
    return [normalize_text(t) for t in raw if normalize_text(t)]


def format_iso(dt):
    """datetime -> Firestore-style millis Z string."""
    if dt is None:
        return ""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_ts(s):
    """ISO Z string -> aware datetime (naive input assumed UTC)."""
    if not s:
        return None
    dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def ts_to_iso(value):
    """Firestore timestamp-ish value (datetime / ISO string) -> ISO Z."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return format_iso(value)
    if isinstance(value, str):
        dt = parse_ts(value)
        return format_iso(dt) if dt else value
    return ""


def snapshot_to_doc(collection, doc):
    """Firestore DocumentSnapshot -> the plain dict detection uses."""
    d = doc.to_dict() or {}
    return {
        "collection": collection,
        "id": doc.id,
        "senderId": d.get("senderId", "") or "",
        "senderName": d.get("senderName", "") or "",
        "kind": d.get("kind", "") or "",
        "content": d.get("content", "") or "",
        "title": d.get("title", "") or "",
        "assigneeId": d.get("assigneeId", "") or "",
        "assigneeName": d.get("assigneeName", "") or "",
        "requesterId": d.get("requesterId", "") or "",
        "requesterName": d.get("requesterName", "") or "",
        "decidedBy": d.get("decidedBy", "") or "",
        "decidedByName": d.get("decidedByName", "") or "",
        "status": d.get("status", "") or "",
        "createdAt": ts_to_iso(d.get("createdAt")),
        "updatedAt": ts_to_iso(d.get("updatedAt")),
        "decidedAt": ts_to_iso(d.get("decidedAt")),
        # Library update_time: distinguishes a MODIFIED re-delivery
        # from the original ADDED delivery of the same document.
        "updateTime": format_iso(getattr(doc, "update_time", None)),
    }


def doc_event_ts(doc):
    """Best timestamp for ordering / checkpointing this document."""
    return (doc.get("updateTime") or doc.get("updatedAt")
            or doc.get("decidedAt") or doc.get("createdAt") or "")


def build_event_id(collection, doc_id, change_type, update_time=""):
    """Unique event id. A MODIFIED re-delivery with a NEW updateTime is
    a NEW event (the document really changed); the same updateTime
    re-delivered (reconnect replay) maps to the SAME id and dedups."""
    base = f"{collection}:{doc_id}"
    if change_type == "MODIFIED" and update_time:
        return f"{base}:{update_time}"
    return base


def classify_event_type(doc):
    """message / task_event / approval_event / system_event."""
    collection = doc.get("collection", "")
    if collection == "tasks":
        return "task_event"
    if collection == "approvals":
        return "approval_event"
    # messages collection: system broadcasts are their own type.
    if normalize_text(doc.get("kind", "")) in SYSTEM_KINDS:
        return "system_event"
    return "message"


def _is_self(doc, self_names_norm, self_sender_id):
    """True if this document was authored by the worker owner."""
    if self_sender_id and doc.get("senderId") == self_sender_id:
        return True
    name = normalize_text(doc.get("senderName", ""))
    if name and name in self_names_norm:
        return True
    return False


def _name_haystack(doc):
    """Normalized text fields in which an assignment may name someone."""
    parts = [doc.get("content", ""), doc.get("title", ""),
             doc.get("assigneeName", ""), doc.get("senderName", ""),
             doc.get("requesterName", ""), doc.get("decidedByName", "")]
    return normalize_text(" ".join(p for p in parts if p))


def detect_event(doc, mode, self_names_norm, self_sender_id):
    """Return (event_type, reason) if doc wakes this worker, else None.

    Pure function. Rules (both modes never wake on own documents):
    - coordinator: any message from the Chairman (senderId "chung"),
      any non-self message mentioning @Muse (i.e. any self name),
      any "Giao việc" message, any task_event, any approval_event,
      any system_event.
    - staff: ONLY when actually called -- @own name (diacritic-free
      match, so @Hùng, @Hung, @Tuấn, @Tuan, @Đặng, @Dang all work),
      a "Giao việc" message naming them, a task_event assigned to
      them (assigneeName or assigneeId), an approval_event naming
      them, or a system_event mentioning them.
    A Chairman message that does NOT name a staff member wakes the
    coordinator ONLY -- never that staff member. That is deliberate:
    staff are not woken by broadcasts they were not called into.
    """
    if _is_self(doc, self_names_norm, self_sender_id):
        return None
    event_type = classify_event_type(doc)
    mentions = extract_mentions(doc.get("content", ""))
    mentioned_self = any(m in self_names_norm for m in mentions)
    haystack = _name_haystack(doc)
    named_self = any(n and n in haystack for n in self_names_norm)
    assigned_self = bool(
        self_sender_id and doc.get("assigneeId")
        and doc.get("assigneeId") == self_sender_id)
    requested_self = bool(
        self_sender_id and doc.get("requesterId")
        and doc.get("requesterId") == self_sender_id)

    if event_type == "system_event":
        if mode == "coordinator":
            return (event_type, "system")
        return (event_type, "mention") if mentioned_self else None

    if mode == "coordinator":
        if doc.get("senderId") == CHAIRMAN_SENDER_ID:
            return (event_type, "chairman")
        if mentioned_self:
            return (event_type, "mention")
        if doc.get("kind") == "Giao việc":
            return (event_type, "assignment")
        if event_type in ("task_event", "approval_event"):
            return (event_type, "task_change" if event_type == "task_event"
                    else "approval")
        return None

    # staff mode
    if mentioned_self:
        return (event_type, "mention")
    if doc.get("kind") == "Giao việc" and named_self:
        return (event_type, "assignment")
    if event_type == "task_event" and (named_self or assigned_self):
        return (event_type, "assignment")
    if event_type == "approval_event" and (named_self or assigned_self
                                          or requested_self):
        return (event_type, "approval")
    return None


def should_skip(event_id, event_ts, doc_id, checkpoint, emitted_ids):
    """True if this event was already handled.

    Two independent guards (either suffices):
      1. event_id already in the persistent emitted set (covers
         reconnect replays, including MODIFIED re-deliveries with the
         same updateTime), and
      2. the per-collection checkpoint: (event_ts, doc_id) at/below
         the last processed (ts, id) -- covers replays after the
         emitted set was trimmed at the 1000 cap.
    A MODIFIED change with a NEW updateTime has a new event_id and a
    newer event_ts, so it is correctly NOT skipped.
    """
    if event_id in emitted_ids:
        return True
    if checkpoint:
        ck_ts, ck_id = checkpoint
        if ck_ts and event_ts:
            if event_ts < ck_ts:
                return True
            if event_ts == ck_ts and doc_id <= ck_id:
                return True
    return False


def is_rate_limited(exc):
    """True for Firestore quota errors: 429 / RESOURCE_EXHAUSTED."""
    text = str(exc)
    return "429" in text or "RESOURCE_EXHAUSTED" in text.upper()


class BackoffPolicy:
    """Exponential backoff with jitter, capped, with a hard attempt cap.

    delay(attempt) with attempt 0-based: base * factor**attempt,
    capped at max_delay; with jitter the returned value is uniformly
    within [0.5x, 1.5x] of that value (still capped). next_delay()
    advances an internal counter and returns None once the attempt
    cap is exhausted -- the caller must then trip the circuit breaker
    instead of retrying forever.
    """

    def __init__(self, base=2.0, factor=2.0, max_delay=300.0,
                 max_attempts=8, jitter=True, rng=None):
        self.base = base
        self.factor = factor
        self.max_delay = max_delay
        self.max_attempts = max_attempts
        self.jitter = jitter
        self.rng = rng or random.Random()
        self.attempt = 0

    def delay(self, attempt):
        raw = min(self.max_delay, self.base * (self.factor ** attempt))
        if self.jitter:
            raw = min(self.max_delay, raw * self.rng.uniform(0.5, 1.5))
        return raw

    def next_delay(self):
        if self.attempt >= self.max_attempts:
            return None
        d = self.delay(self.attempt)
        self.attempt += 1
        return d

    def reset(self):
        self.attempt = 0


class CircuitBreaker:
    """Trips after max_failures consecutive failures; success resets."""

    def __init__(self, max_failures=MAX_CONSECUTIVE_FAILURES):
        self.max_failures = max_failures
        self.failures = 0

    @property
    def tripped(self):
        return self.failures >= self.max_failures

    def record_success(self):
        self.failures = 0

    def record_failure(self):
        self.failures += 1
        return self.tripped


# ------------------------------------------------------------ local I/O

def atomic_write_json(path, obj):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else default
    except Exception:
        return default


def read_boot_time(stat_path="/proc/stat"):
    """Machine boot time (seconds since epoch) from /proc/stat btime.

    Returns None when the file is missing, unreadable, or has no btime
    line: the caller must then fall back to the old counting behavior
    instead of guessing a cause of death.
    """
    try:
        with open(stat_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("btime "):
                    return int(line.split()[1])
    except Exception:
        return None
    return None


# Sentinel for StateStore.begin_run: no boot_time passed means "read
# the machine's own boot time now"; an explicit None means "boot time
# unreadable" (old counting behavior). Tests pass explicit ints.
_READ_BOOT_TIME = object()


class StateStore:
    """Per-worker persistent state (THIS worker's machine only).

    File layout:
      emitted_ids: list of the newest <=1000 event ids (dedup set)
      checkpoints: {collection: {"ts": iso, "id": last doc id}}
      events_total, last_event_ts
      consecutive_restarts, last_exit_ok (None = run in progress),
      ever_ran, run_state ("running" / "failed" / "ok")
      boot_time: epoch seconds of the machine boot that wrote this
        state (None = unknown, e.g. state written before this guard
        existed). Used to tell a VM-replacement death apart from a
        real crash loop: see begin_run.
    """

    def __init__(self, path):
        self.path = path
        self.data = load_json(path, {})
        self.data.setdefault("emitted_ids", [])
        self.data.setdefault("checkpoints", {})
        self.data.setdefault("events_total", 0)
        self.data.setdefault("last_event_ts", "")
        self.data.setdefault("consecutive_restarts", 0)
        self.data.setdefault("last_exit_ok", None)
        self.data.setdefault("ever_ran", False)
        self.data.setdefault("run_state", "unknown")
        self.data.setdefault("boot_time", None)
        self.emitted_ids = set(self.data["emitted_ids"])

    def checkpoint(self, collection):
        ck = self.data["checkpoints"].get(collection) or {}
        return (ck.get("ts", ""), ck.get("id", ""))

    def update_checkpoint(self, collection, ts, doc_id):
        if not ts:
            return False
        old_ts, old_id = self.checkpoint(collection)
        if (ts, doc_id) > (old_ts, old_id):
            self.data["checkpoints"][collection] = {"ts": ts, "id": doc_id}
            return True
        return False

    def mark_emitted(self, event_id):
        if event_id not in self.emitted_ids:
            self.emitted_ids.add(event_id)
            return True
        return False

    def save(self):
        ids = sorted(self.emitted_ids)[-MAX_EMITTED_IDS:]
        # sorted() keeps the newest by string order only loosely, but
        # event ids embed doc ids + timestamps, and the checkpoint
        # (not this list) is the authoritative resume guard, so a
        # trimmed list can never cause a missed message -- at worst a
        # re-evaluation that detect_event then filters again.
        self.data["emitted_ids"] = ids
        self.emitted_ids = set(ids)
        atomic_write_json(self.path, self.data)

    def begin_run(self, boot_time=_READ_BOOT_TIME):
        """Count consecutive abnormal restarts. Returns the count.

        The previous run's death is judged against the machine boot
        time saved in this state file:
        - boot time unreadable (None): safe fallback to the old
          counting below -- never guess a cause of death.
        - no boot time saved yet (first run under the new code):
          initialize boot_time and reset the count to 0. The old
          counter mixed VM-replacement deaths with real crashes, so
          its value is untrustworthy and must not trip the lock.
        - saved boot time differs from the current one: the machine
          was replaced since the last run, so the previous death was
          the VM swap -- reset the count to 0, do not count it.
        - saved boot time matches: the old counting. A previous run
          that ended cleanly (last_exit_ok True) resets the count; a
          previous run that ended abnormally OR was killed mid-run
          (last_exit_ok None after ever_ran) increments it.
        The 5-trip lock itself is unchanged: run_forever still
        refuses to loop once this count reaches
        MAX_CONSECUTIVE_RESTARTS, so a real same-boot crash loop
        still locks exactly as before.
        """
        if boot_time is _READ_BOOT_TIME:
            boot_time = read_boot_time()
        saved_boot = self.data.get("boot_time")
        if boot_time is not None and saved_boot is None:
            # First run under the new code: initialize, do not count.
            self.data["consecutive_restarts"] = 0
        elif boot_time is not None and saved_boot != boot_time:
            # Machine replaced: the previous death was the VM swap.
            self.data["consecutive_restarts"] = 0
        elif self.data.get("ever_ran") and \
                self.data.get("last_exit_ok") is not True:
            self.data["consecutive_restarts"] = int(
                self.data.get("consecutive_restarts", 0)) + 1
        else:
            self.data["consecutive_restarts"] = 0
        if boot_time is not None:
            self.data["boot_time"] = boot_time
        self.data["ever_ran"] = True
        self.data["last_exit_ok"] = None
        self.data["run_state"] = "running"
        self.save()
        return self.data["consecutive_restarts"]

    def end_run(self, ok):
        self.data["last_exit_ok"] = bool(ok)
        if ok:
            self.data["consecutive_restarts"] = 0
            self.data["run_state"] = "ok"
        else:
            self.data["run_state"] = "failed"
        self.save()

    def mark_failed(self):
        self.data["run_state"] = "failed"
        self.save()


def start_time_for_collection(state_store, collection, now=None,
                              lookback_minutes=DEFAULT_LOOKBACK_MINUTES):
    """Query lower bound for a collection: its own checkpoint, or
    (first run, no state) now minus the lookback. NEVER the beginning
    of history: a fresh worker must not wake for old documents."""
    ck_ts, _ = state_store.checkpoint(collection)
    if ck_ts:
        return parse_ts(ck_ts)
    now = now or datetime.now(timezone.utc)
    return now - timedelta(minutes=lookback_minutes)


# ------------------------------------------------------- event processor
# Transport-agnostic: the real gRPC adapter and the fake-transport
# tests both drive this class with (collection, change_type, doc).

class EventProcessor:
    """Turns snapshot changes into local event-log entries.

    Owns dedup + checkpoint advancement. NEVER writes to Firestore,
    NEVER performs the "accept task" step: an emitted event only means
    "notified" (written to the local event log). Accepting is a
    separate downstream job owned by the worker's account holder.
    """

    def __init__(self, mode, self_names_norm, self_sender_id,
                 state_store, event_log_path):
        self.mode = mode
        self.self_names_norm = self_names_norm
        self.self_sender_id = self_sender_id
        self.state = state_store
        self.event_log_path = event_log_path
        self.lock = threading.RLock()

    def process_change(self, collection, change_type, doc, stream_key=None):
        """Process one change. Returns the emitted event dict or None.

        Skipped (already seen) and seen-but-not-wake-worthy changes
        still advance the emitted set + checkpoint, so a reconnect
        replay never re-evaluates them.

        stream_key: normally None (= collection). The "approvals-decided"
        stream passes "approvals-decided": it gets its own checkpoint
        and its own event_id namespace (approvals:<id>:decided:<ts>),
        so a decision is never confused with the createdAt ADDED event
        of the same approval. A MODIFIED refire with the same decidedAt
        yields the same event_id and is dropped by dedup.
        """
        if change_type not in ("ADDED", "MODIFIED"):
            return None
        doc = dict(doc)
        doc["collection"] = collection
        ckpt_key = stream_key or collection
        if stream_key == "approvals-decided":
            decided_at = doc.get("decidedAt", "")
            if not decided_at:
                return None  # cannot be in this query's results; guard
            event_ts = decided_at
            event_id = (f"approvals:{doc['id']}:decided:{decided_at}")
        else:
            event_ts = doc_event_ts(doc)
            if not event_ts:
                return None  # server timestamp not committed yet
            event_id = build_event_id(collection, doc["id"], change_type,
                                      doc.get("updateTime", ""))
        with self.lock:
            checkpoint = self.state.checkpoint(ckpt_key)
            if should_skip(event_id, event_ts, doc["id"], checkpoint,
                           self.state.emitted_ids):
                return None
            self.state.mark_emitted(event_id)
            self.state.update_checkpoint(ckpt_key, event_ts, doc["id"])
            detected = detect_event(doc, self.mode,
                                    self.self_names_norm,
                                    self.self_sender_id)
            if detected is None:
                return None
            event_type, reason = detected
            event = {
                "event_id": event_id,
                "type": event_type,
                "collection": collection,
                "doc_id": doc["id"],
                "ts": event_ts,
                "sender_id": doc.get("senderId", ""),
                "sender_name": doc.get("senderName", ""),
                "kind": doc.get("kind", ""),
                "reason": reason,
                "content": doc.get("content", ""),
                "notified": True,
                # Explicit non-step: acceptance is NOT done here.
                "accepted": False,
                "detected_at": datetime.now(timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"),
            }
            with open(self.event_log_path, "a",
                       encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            self.state.data["events_total"] = int(
                self.state.data.get("events_total", 0)) + 1
            self.state.data["last_event_ts"] = event_ts
            return event

    def process_batch(self, changes):
        """changes: iterable of (collection, change_type, doc_dict) or
        (collection, change_type, doc_dict, stream_key)."""
        emitted = []
        for item in changes:
            collection, change_type, doc = item[0], item[1], item[2]
            stream_key = item[3] if len(item) > 3 else None
            try:
                ev = self.process_change(collection, change_type, doc,
                                         stream_key=stream_key)
            except Exception as exc:
                log(f"change processing failed, skipping: {exc!r}")
                continue
            if ev is not None:
                emitted.append(ev)
        with self.lock:
            self.state.save()
        return emitted


# ---------------------------------------------------------- health check

def read_status(path):
    """Status dict from file, or None if missing/unreadable."""
    d = load_json(path, None)
    return d if isinstance(d, dict) else None


def health_status(path):
    """Health JSON payload. No network, no credential -- file only."""
    st = read_status(path)
    if st is None:
        return {"ok": False, "error": "status file not found",
                "status_file": path}
    return {
        "ok": True,
        "pid": st.get("pid"),
        "state": st.get("run_state", st.get("state", "unknown")),
        "stream_connected": bool(st.get("stream_connected", False)),
        "events_total": int(st.get("events_total", 0)),
        "last_event_ts": st.get("last_event_ts", ""),
        "last_error": st.get("last_error", ""),
        "restart_count": int(st.get("restart_count",
                                    st.get("consecutive_restarts", 0))),
        "updated_at": st.get("updated_at", ""),
    }


# ------------------------------------------------------- sign-in (v1 pattern)

def curl_json_post(url, payload, timeout=90):
    body_path = None
    try:
        fd, body_path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        args = ["curl", "-sS", "--max-time", str(timeout),
                "-X", "POST", "-H", "Content-Type: application/json",
                "--data-binary", "@" + body_path, url]
        proc = subprocess.run(args, capture_output=True, text=True,
                              timeout=timeout + 30)
        try:
            return json.loads(proc.stdout) if proc.stdout.strip() else {}
        except Exception:
            return {}
    finally:
        if body_path and os.path.exists(body_path):
            os.unlink(body_path)


def sign_in(email, password):
    """Return (id_token, expires_in_secs). Never includes the code in
    any error. Requires FIREBASE_API_KEY in the environment (the
    public web-app key, not a credential)."""
    api_key = os.environ.get("FIREBASE_API_KEY", "")
    if not api_key:
        raise RuntimeError("FIREBASE_API_KEY is not set in the "
                           "environment (public web-app key)")
    body = curl_json_post(IDENTITY_URL_TMPL.format(key=api_key),
                          {"email": email, "password": password,
                           "returnSecureToken": True})
    if "idToken" not in body:
        err = body.get("error", {}).get("message", "unknown")
        raise RuntimeError(f"sign-in failed: {err}")
    try:
        expires = int(body.get("expiresIn", "3600"))
    except ValueError:
        expires = 3600
    return body["idToken"], expires


class FirebaseCreds(_GoogleCredentials if _HAVE_FIRESTORE else object):
    """google-auth credentials backed by a Firebase Auth idToken.

    refresh() re-signs in from memory. CRITICAL v1 LESSON: never call
    refresh() manually before Client creation -- validate with a
    throwaway sign_in() and let the library refresh lazily instead.
    """

    def __init__(self, email, code):
        if _HAVE_FIRESTORE:
            super().__init__()
        self._email = email
        self._code = code

    def refresh(self, request):
        token, _ = sign_in(self._email, self._code)
        self.token = token
        self.expiry = (datetime.now(timezone.utc)
                       + timedelta(seconds=FIREBASE_TOKEN_TTL_SECS))


# ------------------------------------------------------------ gRPC worker

# Per-collection query field: tasks track updates, approvals track
# creation (they carry no updatedAt in the app code -- see header).
QUERY_FIELDS = {
    "messages": "createdAt",
    "tasks": "updatedAt",
    "approvals": "createdAt",
}

# (stream_key, collection, field). Luong thu 4 "approvals-decided" dong
# khoang trong: approval tao TRUOC khi worker mo stream khong bao gio
# roi vao tap ket qua createdAt >= start, nen quyet dinh duyet sau do
# khong ve qua stream createdAt. Truy van 1 truong (decidedAt >= start)
# khong can composite index. Chong bao trung voi stream createdAt
# (cung quyet dinh co the ve 2 duong) do worker xu ly: xem
# worker.should_process_decision (1 doc_id duyet chi thong bao 1 lan).
STREAMS = (
    ("messages", "messages", "createdAt"),
    ("tasks", "tasks", "updatedAt"),
    ("approvals", "approvals", "createdAt"),
    ("approvals-decided", "approvals", "decidedAt"),
)


POST_QUEUE_FILE = "post-queue.jsonl"
POST_QUEUE_OFFSET_FILE = "post-queue.offset"
POST_QUEUE_SENT_FILE = "post-queue.sent.jsonl"
POST_QUEUE_POLL_SECS = 10.0
POST_QUEUE_MAX_BYTES = 1_000_000
POST_QUEUE_MAX_PER_CYCLE = 20


def _read_queue_offset(path):
    try:
        with open(path, encoding="utf-8") as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _write_queue_offset(path, value):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(str(value))
    os.replace(tmp, path)


def drain_post_queue(client, queue_path, offset_path, sent_path,
                     sender_id, sender_name, log):
    """Post queued room messages (coordinator only, best-effort).

    Queue format: 1 JSON object per line: {"kind": ..., "content": ...}.
    Sender is ALWAYS this process's own identity (sender_id/name args)
    — queue lines cannot impersonate anyone else.

    Offset semantics: the file is append-only; offset advances past
    each line only after that line is posted (or skipped as malformed
    / missing kind/content). A failed post STOPS the drain without
    advancing past the failed line, so the next cycle retries it —
    no loss, and at most one duplicate if the process dies between a
    successful post and its offset write. A post failure NEVER raises
    out of this function into the listen loop (caller also guards);
    listening coverage is more important than any queued message.
    When fully drained and the file is large, it is compacted to
    empty so the queue does not grow forever.
    Returns the number of messages posted this cycle.
    """
    try:
        size = os.path.getsize(queue_path)
    except OSError:
        return 0
    offset = _read_queue_offset(offset_path)
    if offset < 0 or offset > size:
        offset = 0
    if offset == size:
        return 0
    try:
        with open(queue_path, "rb") as f:
            f.seek(offset)
            raw = f.read()
    except OSError as exc:
        log(f"post queue read error: {exc!r}")
        return 0
    try:
        server_ts = _firestore.SERVER_TIMESTAMP
    except (NameError, AttributeError):
        server_ts = None
    posted = 0
    pos = offset
    for line in raw.splitlines(keepends=True):
        pos += len(line)
        text = line.decode("utf-8", "replace").strip()
        if not text:
            _write_queue_offset(offset_path, pos)
            continue
        try:
            item = json.loads(text)
        except ValueError:
            log("post queue: skipping malformed line")
            _write_queue_offset(offset_path, pos)
            continue
        if not isinstance(item, dict):
            log("post queue: skipping non-object line")
            _write_queue_offset(offset_path, pos)
            continue
        kind = str(item.get("kind", "") or "").strip()
        content = str(item.get("content", "") or "").strip()
        if not kind or not content:
            log("post queue: skipping line without kind/content")
            _write_queue_offset(offset_path, pos)
            continue
        try:
            ref = client.collection("messages").add({
                "senderId": sender_id,
                "senderName": sender_name,
                "kind": kind,
                "content": content,
                "createdAt": server_ts,
            })
        except Exception as exc:
            log(f"post queue: post failed, will retry next cycle: "
                f"{exc!r}")
            return posted
        doc_id = ""
        try:
            doc_id = ref[1].id if isinstance(ref, tuple) else getattr(
                ref, "id", "")
        except Exception:
            doc_id = ""
        try:
            with open(sent_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "doc_id": doc_id,
                    "kind": kind,
                    "content_len": len(content),
                    "posted_at": datetime.now(timezone.utc).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"),
                }, ensure_ascii=False) + "\n")
        except OSError:
            pass
        _write_queue_offset(offset_path, pos)
        posted += 1
        if posted >= POST_QUEUE_MAX_PER_CYCLE:
            break
    try:
        if pos >= os.path.getsize(queue_path) and pos >= POST_QUEUE_MAX_BYTES:
            with open(queue_path, "wb"):
                pass
            _write_queue_offset(offset_path, 0)
    except OSError:
        pass
    return posted


class GrpcWorker:
    def __init__(self, args, credential):
        self.args = args
        self.credential = credential
        self.script_dir = os.path.dirname(os.path.abspath(__file__))
        self.event_log = args.event_log or os.path.join(
            self.script_dir, "listener_v2.events.jsonl")
        self.state_path = args.state_file or os.path.join(
            self.script_dir, "listener_v2.state.json")
        self.status_path = args.status_file or os.path.join(
            self.script_dir, "listener_v2.status.json")
        self.pid_path = args.pid_file or os.path.join(
            self.script_dir, "listener_v2.pid")
        self.state = StateStore(self.state_path)
        self.self_names_norm = [normalize_text(n) for n in
                                args.self_names.split(",") if n.strip()]
        self.processor = EventProcessor(
            args.mode, self.self_names_norm, args.self_sender_id,
            self.state, self.event_log)
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.watches = []
        self.watch_dead = False
        self.stream_connected = False
        self.last_error = ""
        self.last_snapshot_at = 0.0
        self.last_heartbeat_at = 0.0
        self.circuit = CircuitBreaker()
        self.backoff = BackoffPolicy()
        self.started_at = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")

    def save_status(self):
        atomic_write_json(self.status_path, {
            "pid": os.getpid(),
            "mode": self.args.mode,
            "started_at": self.started_at,
            "stream_connected": self.stream_connected,
            "events_total": int(self.state.data.get("events_total", 0)),
            "last_event_ts": self.state.data.get("last_event_ts", ""),
            "last_error": self.last_error,
            "restart_count": int(
                self.state.data.get("consecutive_restarts", 0)),
            "consecutive_restarts": int(
                self.state.data.get("consecutive_restarts", 0)),
            "run_state": self.state.data.get("run_state", "running"),
            "updated_at": datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
        })

    def _on_snapshot(self, stream_key, collection):
        def callback(docs, changes, read_time):
            try:
                self.last_snapshot_at = time.time()
                self.stream_connected = True
                self.circuit.record_success()
                batch = []
                for ch in changes:
                    if ch.type.name not in ("ADDED", "MODIFIED"):
                        continue
                    try:
                        batch.append((collection, ch.type.name,
                                      snapshot_to_doc(collection,
                                                      ch.document),
                                      stream_key))
                    except Exception as exc:
                        log(f"snapshot parse failed, skipping: {exc!r}")
                if batch:
                    emitted = self.processor.process_batch(batch)
                    for ev in emitted:
                        log(f"EVENT {ev['type']}/{ev['reason']} "
                            f"id={ev['doc_id']} "
                            f"from={ev['sender_name']} "
                            f"kind={ev['kind']}")
                with self.lock:
                    self.save_status()
            except Exception as exc:
                log(f"snapshot callback error: {exc!r}")
        return callback

    def _monitor(self):
        inactive_streak = 0
        while not self.stop_event.wait(MONITOR_INTERVAL_SECS):
            try:
                all_active = True
                for watch in self.watches:
                    try:
                        active = watch.is_active
                        if callable(active):
                            active = active()
                        if not active:
                            all_active = False
                    except Exception:
                        all_active = False
                if all_active and self.watches:
                    inactive_streak = 0
                    self.stream_connected = True
                else:
                    inactive_streak += 1
                    log(f"watch inactive streak={inactive_streak}")
                    if inactive_streak >= DEAD_STREAK_LIMIT:
                        log("watch dead 3 checks in a row; exiting "
                            "for watchdog restart")
                        self.watch_dead = True
                        self.stop_event.set()
                        return
                now = time.time()
                if (self.last_snapshot_at
                        and now - self.last_snapshot_at > HEARTBEAT_QUIET_SECS
                        and now - self.last_heartbeat_at > HEARTBEAT_QUIET_SECS):
                    self.last_heartbeat_at = now
                    log("heartbeat: stream quiet, process alive")
                with self.lock:
                    self.save_status()
            except Exception as exc:
                log(f"monitor error: {exc!r}")

    def _open_watches(self, client):
        watches = []
        for stream_key, collection, field in STREAMS:
            start = start_time_for_collection(
                self.state, stream_key,
                lookback_minutes=self.args.lookback_minutes)
            query = (client.collection(collection)
                     .where(filter=FieldFilter(field, ">=", start))
                     .order_by(field))
            watches.append(query.on_snapshot(
                self._on_snapshot(stream_key, collection)))
        return watches

    def run_forever(self):
        with open(self.pid_path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        restarts = self.state.begin_run()
        if restarts >= MAX_CONSECUTIVE_RESTARTS:
            log(f"restart loop detected ({restarts} consecutive "
                "abnormal restarts); refusing to loop -- state=failed, "
                "a human must look before any restart")
            self.state.mark_failed()
            self.last_error = "restart loop detected"
            try:
                self.save_status()
            except Exception:
                pass
            return 7
        self.save_status()
        creds = FirebaseCreds(self.args.email, self.credential)
        try:
            # Validate with a throwaway sign-in and DISCARD the token.
            # DO NOT call creds.refresh() here (v1 bisection: it kills
            # the stream). The library refreshes lazily on first use.
            sign_in(self.args.email, self.credential)
        except RuntimeError as exc:
            log(f"fatal: {exc}")
            self.last_error = str(exc)[:200]
            self.state.end_run(False)
            try:
                self.save_status()
            except Exception:
                pass
            return 3
        log("code validated, opening Firestore watches")
        while not self.stop_event.is_set():
            try:
                client = _firestore.Client(project=PROJECT,
                                           credentials=creds)
                self.watches = self._open_watches(client)
            except Exception as exc:
                self.last_error = str(exc)[:200]
                tripped = self.circuit.record_failure()
                if is_rate_limited(exc):
                    # Quota: LONG pause, no burst retry, and never a
                    # full-history re-read -- the next resume reuses
                    # the same per-collection checkpoints.
                    log("rate limited (429): pausing "
                        f"{RATE_LIMIT_BACKOFF_SECS}s before resume; "
                        "checkpoints preserved, no re-read")
                    self.stream_connected = False
                    try:
                        self.save_status()
                    except Exception:
                        pass
                    if self.stop_event.wait(RATE_LIMIT_BACKOFF_SECS):
                        break
                    continue
                if tripped:
                    log("circuit breaker tripped after "
                        f"{self.circuit.failures} consecutive failures; "
                        "state=failed, needs a human")
                    self.state.mark_failed()
                    try:
                        self.save_status()
                    except Exception:
                        pass
                    return 7
                delay = self.backoff.next_delay()
                if delay is None:
                    log("retry cap exhausted; circuit breaker tripped")
                    self.state.mark_failed()
                    try:
                        self.save_status()
                    except Exception:
                        pass
                    return 7
                log(f"watch setup failed ({exc!r}); retrying in "
                    f"{delay:.1f}s (attempt {self.backoff.attempt})")
                if self.stop_event.wait(delay):
                    break
                continue
            log(f"watches opened (gRPC Listen streams x{len(STREAMS)})")
            self.stream_connected = True
            self.last_snapshot_at = time.time()
            self.backoff.reset()
            monitor = threading.Thread(target=self._monitor, daemon=True)
            monitor.start()
            # Coordinator post queue: the coordinator process is already
            # authenticated, so queued messages post with its live
            # client — no fresh sign-in needed. Best-effort only: a
            # queue error must never break listening.
            queue_dir = os.path.dirname(os.path.abspath(self.status_path))
            queue_path = os.path.join(queue_dir, POST_QUEUE_FILE)
            offset_path = os.path.join(queue_dir, POST_QUEUE_OFFSET_FILE)
            sent_path = os.path.join(queue_dir, POST_QUEUE_SENT_FILE)
            sender_name = (self.args.self_names.split(",")[0].strip()
                           if self.args.self_names
                           else self.args.self_sender_id)
            last_queue_drain = 0.0
            while not self.stop_event.is_set():
                time.sleep(0.5)
                if self.args.mode == "coordinator":
                    now = time.time()
                    if now - last_queue_drain >= POST_QUEUE_POLL_SECS:
                        last_queue_drain = now
                        try:
                            n = drain_post_queue(
                                client, queue_path, offset_path, sent_path,
                                self.args.self_sender_id, sender_name, log)
                            if n:
                                log(f"post queue: posted {n} message(s)")
                        except Exception as exc:
                            log(f"post queue error: {exc!r}")
            break
        for watch in self.watches:
            try:
                watch.unsubscribe()
            except Exception:
                pass
        self.stream_connected = False
        ok = not self.watch_dead
        try:
            with self.lock:
                self.state.end_run(ok)
                self.save_status()
        except Exception:
            pass
        try:
            if os.path.exists(self.pid_path):
                os.unlink(self.pid_path)
        except OSError:
            pass
        return 5 if self.watch_dead else 0


def read_credential(args):
    if args.credential_file:
        with open(args.credential_file, encoding="utf-8") as f:
            lines = f.read().strip().splitlines()
        code = lines[0].strip() if lines else ""
        if not code:
            print("credential file is empty", file=sys.stderr)
            raise SystemExit(42)
        return code
    data = sys.stdin.readline()
    code = data.strip() if data else ""
    if not code:
        print("no credential: pipe the access code on stdin "
              "or pass --credential-file", file=sys.stderr)
        raise SystemExit(42)
    return code


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "health-check":
        ap = argparse.ArgumentParser()
        ap.add_argument("--status-file", default="listener_v2.status.json")
        a = ap.parse_args(argv[1:])
        payload = health_status(a.status_file)
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if payload.get("ok") else 2
    if not _HAVE_FIRESTORE:
        print("google-cloud-firestore is not installed for this "
              "interpreter. Create a venv and run:\n"
              "  python3 -m venv .venv && .venv/bin/pip install "
              "google-cloud-firestore\nthen start the listener with "
              ".venv/bin/python.", file=sys.stderr)
        return 6
    if (not os.environ.get("SSL_CERT_FILE")
            and os.path.exists(PROXY_CA_BUNDLE)):
        os.environ["SSL_CERT_FILE"] = PROXY_CA_BUNDLE
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=["coordinator", "staff"],
                    default="coordinator")
    ap.add_argument("--email", default="muse@aicompany.app")
    ap.add_argument("--self-names", default="Muse",
                    help="comma-separated @ spellings that wake this "
                         "listener, e.g. 'Hùng,Hung'")
    ap.add_argument("--self-sender-id", default="Muse",
                    help="senderId of own messages to ignore; empty "
                         "disables id matching (name matching remains)")
    ap.add_argument("--credential-file", default="")
    ap.add_argument("--event-log", default="")
    ap.add_argument("--state-file", default="")
    ap.add_argument("--status-file", default="")
    ap.add_argument("--pid-file", default="")
    ap.add_argument("--lookback-minutes", type=int,
                    default=DEFAULT_LOOKBACK_MINUTES,
                    help="first-run start offset (minutes before now); "
                         "ignored once a per-collection checkpoint "
                         "exists")
    args = ap.parse_args(argv)
    credential = read_credential(args)
    worker = GrpcWorker(args, credential)
    credential = None  # drop the local reference; worker holds memory

    def on_signal(signum, frame):
        worker.stop_event.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    return worker.run_forever()


if __name__ == "__main__":
    sys.exit(main())
