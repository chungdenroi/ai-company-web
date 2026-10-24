#!/usr/bin/env python3
"""Realtime listener for the Enteesee meeting room (Firestore Listen stream).

Transport (important correction, verified 2026-10-24):
Google's Firestore API states that `documents.listen` is "only available
via gRPC or WebChannel (not REST)". A plain REST POST to `:listen` is
rejected by Google's frontend with HTTP 400 "Invalid value (Object)"
for EVERY body, including `{}` — verified with 9 request variants.
So this listener uses the official google-cloud-firestore client, whose
`on_snapshot` is a real `google.firestore.v1.Firestore.Listen` gRPC
stream: ONE long-lived stream, reads charged only when a matching
document actually changes. No polling of any kind.

Quota-safe design (Spark free tier, ~50k reads/day; a past 34h HTTP 429
outage was caused by polling that re-read whole collections):
- The query filter starts at the guard's watermark (local file, free),
  so the initial snapshot contains only messages since the last guard
  poll (usually 0-few docs). Documents at/below the watermark are
  skipped, so the listener never re-wakes for messages the guard
  already handled.
- On reconnect, the client library resumes the stream internally with
  its saved resume token (no re-read). The 15-minute guard poll remains
  the backstop for anything the listener misses.
- A monitor thread watches `watch.is_active()`: 3 consecutive dead
  checks (3 minutes) exit the process so the watchdog cron restarts it
  with a fresh code.
- The access code is read from stdin (line 1) or --credential-file at
  startup and kept ONLY in process memory. It is never printed, never
  written to disk, never passed in argv. Token refresh (every ~50 min)
  re-signs in from memory.
- Detected events are appended to a local JSONL event log (fsync each
  write). NOTHING is written back to Firestore on detection.

Detection rules:
- coordinator mode: any new message from the Chairman (senderId
  "chung"), any non-self message mentioning @Muse, or any new
  "Giao việc" message (not from self).
- staff mode: any non-self message mentioning the staff member's own
  @name, or a "Giao việc" message mentioning their name.
- Own messages (senderId or senderName matching self) are never events.

Runtime requirement: run with a Python that has google-cloud-firestore
installed (a venv under this directory works; system pip is blocked by
PEP 668 on this VM):
    .venv/bin/python listener.py --mode coordinator ...

Usage (coordinator, started by the watchdog cron which pipes the code):
    printf '%s\n' "$CODE" | .venv/bin/python listener.py \
        --mode coordinator

Usage (staff, own environment, own credential):
    .venv/bin/python listener.py --mode staff \
        --email you@aicompany.app --self-names "Hùng,Hung" \
        --credential-file ~/.config/room-code

Exit codes: 0 clean shutdown, 3 sign-in failed (watchdog restarts with a
fresh code), 5 watch dead (monitor saw is_active False 3x), 42 no
credential supplied, 6 google-cloud-firestore not installed for this
interpreter, 1 other fatal error.
"""

import argparse
import json
import os
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
# Public Firebase web key: already shipped in the public web app config
# and in the guard script. It is not a secret credential.
API_KEY = "AIzaSyDUViybhB6xmC7Q9qQBJtFgYxH6OlpJbxU"
IDENTITY_URL = ("https://identitytoolkit.googleapis.com/v1"
                "/accounts:signInWithPassword?key=" + API_KEY)
CHAIRMAN_SENDER_ID = "chung"
FIREBASE_TOKEN_TTL_SECS = 50 * 60
# Egress proxy re-signs TLS with its own CA; grpc must trust it.
PROXY_CA_BUNDLE = "/run/hatch/egress-tls/ca-bundle.pem"


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def normalize_text(s):
    """Lowercase + strip diacritics (incl. Vietnamese d/D) for @matching."""
    if not s:
        return ""
    s = s.replace("đ", "d").replace("Đ", "D")
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    return s.lower().strip()


def extract_mentions(content):
    """Return normalized tokens following @ in content."""
    if not content:
        return []
    raw = re.findall(r"@([^\s@,;:!?()\[\]\"'.]+)", content)
    return [normalize_text(t) for t in raw if normalize_text(t)]


def format_iso(dt):
    """datetime -> Firestore-style millis Z string (for comparisons)."""
    if dt is None:
        return ""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_ts(s):
    """ISO Z string -> aware datetime (naive input assumed UTC)."""
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def snapshot_to_msg(doc):
    """Firestore DocumentSnapshot -> the msg dict detection uses."""
    d = doc.to_dict() or {}
    return {
        "id": doc.id,
        "senderId": d.get("senderId", "") or "",
        "senderName": d.get("senderName", "") or "",
        "kind": d.get("kind", "") or "",
        "content": d.get("content", "") or "",
        "createdAt": format_iso(doc.create_time),
    }


def detect_event(msg, mode, self_names_norm, self_sender_id):
    """Return a reason string if msg is a wake-worthy event, else None.

    Pure function (unit-tested). Never inspects credentials or disk.
    """
    sender_id = msg.get("senderId", "")
    sender_name = msg.get("senderName", "")
    kind = msg.get("kind", "")
    content = msg.get("content", "")
    # Never wake on own messages (by sender id or by sender name).
    if self_sender_id and sender_id == self_sender_id:
        return None
    if sender_name and normalize_text(sender_name) in self_names_norm:
        return None
    mentions = extract_mentions(content)
    mentioned_self = any(m in self_names_norm for m in mentions)
    if mode == "coordinator":
        if sender_id == CHAIRMAN_SENDER_ID:
            return "chairman"
        if mentioned_self:
            return "mention"
        if kind == "Giao việc":
            return "assignment"
        return None
    # staff mode: only wake when the staff member is actually called.
    if mentioned_self:
        return "mention"
    if kind == "Giao việc":
        hay = normalize_text(content)
        if any(n and n in hay for n in self_names_norm):
            return "assignment"
    return None


def should_skip(msg, watermark, emitted_ids):
    """True if msg was already handled (watermark anchor or seen id)."""
    if msg["id"] in emitted_ids:
        return True
    wm_ts, wm_id = watermark
    if wm_ts:
        cts = msg.get("createdAt", "")
        if cts < wm_ts or (cts == wm_ts and msg["id"] <= wm_id):
            return True
    return False


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


def read_watermark(path):
    if not path:
        return ("", "")
    d = load_json(path, {})
    return (d.get("lastSeenTs", ""), d.get("lastSeenId", ""))


def curl_json_post(url, payload, token=None, timeout=90):
    """POST JSON via curl (urllib is unreliable on this VM). Returns the
    parsed body dict. Payload is written to a temp file and deleted
    afterwards; never passed in argv. Used only for Identity Toolkit
    sign-in (a plain unary REST call, which works fine)."""
    body_path = None
    try:
        fd, body_path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        args = ["curl", "-sS", "--max-time", str(timeout),
                "-X", "POST", "-H", "Content-Type: application/json"]
        if token:
            args += ["-H", "Authorization: Bearer " + token]
        args += ["--data-binary", "@" + body_path, url]
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
    """Return (id_token, expires_in_secs). Raises on failure without
    ever including the password in the error."""
    body = curl_json_post(
        IDENTITY_URL,
        {"email": email, "password": password, "returnSecureToken": True})
    if "idToken" not in body:
        err = body.get("error", {}).get("message", "unknown")
        raise RuntimeError(f"sign-in failed: {err}")
    try:
        expires = int(body.get("expiresIn", "3600"))
    except ValueError:
        expires = 3600
    return body["idToken"], expires


class FirebaseCreds(_GoogleCredentials):
    """google-auth credentials backed by a Firebase Auth idToken.

    refresh() re-signs in with the account email + access code held in
    memory (never written anywhere). Token lifetime is capped below
    the Firebase ~1h expiry so refresh happens proactively.
    """

    def __init__(self, email, code):
        super().__init__()
        self._email = email
        self._code = code

    def refresh(self, request):
        token, _ = sign_in(self._email, self._code)
        self.token = token
        self.expiry = (datetime.now(timezone.utc)
                       + timedelta(seconds=FIREBASE_TOKEN_TTL_SECS))


class GrpcListener:
    def __init__(self, args, credential):
        self.args = args
        self.credential = credential
        self.script_dir = os.path.dirname(os.path.abspath(__file__))
        self.event_log = args.event_log or os.path.join(self.script_dir,
                                                         "events.jsonl")
        self.state_path = args.state_file or os.path.join(
            self.script_dir, "listener.state.json")
        self.status_path = args.status_file or os.path.join(
            self.script_dir, "listener.status.json")
        self.pid_path = args.pid_file or os.path.join(self.script_dir,
                                                      "listener.pid")
        self.watermark = read_watermark(args.watermark_file)
        self.state = load_json(self.state_path, {})
        self.emitted_ids = set(self.state.get("emitted_ids", []))
        self.events_total = int(self.state.get("events_total", 0))
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.watch = None
        self.watch_dead = False
        self.stream_connected = False
        self.last_error = ""
        self.last_snapshot_at = 0.0
        self.last_heartbeat_at = 0.0
        self.self_names_norm = [normalize_text(n) for n in
                                args.self_names.split(",") if n.strip()]
        self.started_at = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")

    # ---- state/status plumbing (local files only, no Firestore) ----
    def save_state(self):
        ids = sorted(self.emitted_ids)[-1000:]
        atomic_write_json(self.state_path, {
            "emitted_ids": ids,
            "events_total": self.events_total,
            "last_event_ts": self.state.get("last_event_ts", ""),
            "updated_at": datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
        })

    def save_status(self):
        atomic_write_json(self.status_path, {
            "pid": os.getpid(),
            "mode": self.args.mode,
            "started_at": self.started_at,
            "stream_connected": self.stream_connected,
            "events_total": self.events_total,
            "last_event_ts": self.state.get("last_event_ts", ""),
            "last_error": self.last_error,
            "updated_at": datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
        })

    def write_pid(self):
        with open(self.pid_path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))

    def emit_event(self, msg, reason):
        ev = {
            "event_id": msg["id"],
            "ts": msg.get("createdAt", ""),
            "sender_id": msg.get("senderId", ""),
            "sender_name": msg.get("senderName", ""),
            "kind": msg.get("kind", ""),
            "reason": reason,
            "content": msg.get("content", ""),
            "detected_at": datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
        }
        with self.lock:
            with open(self.event_log, "a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            self.emitted_ids.add(msg["id"])
            self.events_total += 1
            self.state["last_event_ts"] = ev["ts"]
            self.save_state()
            self.save_status()
        log(f"EVENT {reason} id={msg['id']} from={msg.get('senderName','')} "
            f"kind={msg.get('kind','')}")

    # ---- watch callback (runs on the library's thread) ----
    def _on_snapshot(self, docs, changes, read_time):
        try:
            self.last_snapshot_at = time.time()
            self.stream_connected = True
            dirty = False
            for ch in changes:
                if ch.type.name not in ("ADDED", "MODIFIED"):
                    continue
                try:
                    msg = snapshot_to_msg(ch.document)
                except Exception as exc:
                    log(f"snapshot parse failed, skipping: {exc!r}")
                    continue
                if not msg.get("createdAt"):
                    continue  # server timestamp not committed yet
                if should_skip(msg, self.watermark, self.emitted_ids):
                    with self.lock:
                        self.emitted_ids.add(msg["id"])
                        dirty = True
                    continue
                reason = detect_event(
                    msg, self.args.mode, self.self_names_norm,
                    self.args.self_sender_id)
                if reason:
                    self.emit_event(msg, reason)
                else:
                    # Seen but not wake-worthy: still mark emitted so a
                    # reconnect replay never re-evaluates it.
                    with self.lock:
                        self.emitted_ids.add(msg["id"])
                        dirty = True
            with self.lock:
                if dirty:
                    self.save_state()
                self.save_status()
        except Exception as exc:
            # Never let one bad snapshot kill the watch.
            log(f"snapshot callback error: {exc!r}")

    # ---- monitor: liveness + heartbeat ----
    def _monitor(self):
        inactive_streak = 0
        while not self.stop_event.wait(60):
            try:
                watch = self.watch
                if watch is not None:
                    try:
                        active = bool(watch.is_active)
                    except Exception:
                        active = False
                    if active:
                        inactive_streak = 0
                        self.stream_connected = True
                    else:
                        inactive_streak += 1
                        log(f"watch inactive streak={inactive_streak}")
                        if inactive_streak >= 3:
                            log("watch dead 3 checks in a row; "
                                "exiting for watchdog restart")
                            self.watch_dead = True
                            self.stop_event.set()
                            return
                now = time.time()
                if (self.last_snapshot_at
                        and now - self.last_snapshot_at > 300
                        and now - self.last_heartbeat_at > 300):
                    self.last_heartbeat_at = now
                    log("heartbeat: stream quiet, process alive")
                with self.lock:
                    self.save_status()
            except Exception as exc:
                log(f"monitor error: {exc!r}")

    def run_forever(self):
        self.write_pid()
        self.save_status()
        creds = FirebaseCreds(self.args.email, self.credential)
        try:
            # Validate the code with a throwaway sign-in and DISCARD the
            # token: the library must perform its own lazy refresh on
            # first stream use. Bisection 2026-10-24 proved that setting
            # the token here via creds.refresh() before Client creation
            # breaks the Listen stream (0 snapshots, CPU spin), while
            # lazy refresh is healthy. Fail-fast is preserved: a bad code
            # still exits 3 here instead of dying later in the stream.
            # DO NOT "restore" creds.refresh() here.
            sign_in(self.args.email, self.credential)
        except RuntimeError as exc:
            log(f"fatal: {exc}")
            self.last_error = str(exc)[:200]
            try:
                self.save_status()
            except Exception:
                pass
            return 3
        log("code validated, opening Firestore watch")
        try:
            client = _firestore.Client(project=PROJECT, credentials=creds)
            wm_ts = self.watermark[0]
            if wm_ts:
                filt = parse_ts(wm_ts)
            else:
                filt = datetime.now(timezone.utc) - timedelta(minutes=5)
            query = (client.collection("messages")
                     .where(filter=FieldFilter("createdAt", ">=", filt))
                     .order_by("createdAt"))
            self.watch = query.on_snapshot(self._on_snapshot)
        except Exception as exc:
            log(f"fatal: watch setup failed: {exc!r}")
            self.last_error = str(exc)[:200]
            try:
                self.save_status()
            except Exception:
                pass
            return 1
        log("watch opened (gRPC Listen stream)")
        self.stream_connected = True
        self.last_snapshot_at = time.time()
        monitor = threading.Thread(target=self._monitor, daemon=True)
        monitor.start()
        while not self.stop_event.is_set():
            time.sleep(0.5)
        try:
            if self.watch is not None:
                self.watch.unsubscribe()
        except Exception:
            pass
        self.stream_connected = False
        try:
            with self.lock:
                self.save_state()
                self.save_status()
        except Exception:
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
    if not _HAVE_FIRESTORE:
        print("google-cloud-firestore is not installed for this "
              "interpreter. Create a venv and run:\n"
              "  python3 -m venv .venv && .venv/bin/pip install "
              "google-cloud-firestore\nthen start the listener with "
              ".venv/bin/python.", file=sys.stderr)
        return 6
    # grpc must trust the egress proxy's CA when present.
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
    ap.add_argument("--watermark-file", default="",
                    help="guard watermark JSON (coordinator only); "
                         "empty disables watermark dedup")
    args = ap.parse_args(argv)
    credential = read_credential(args)
    listener = GrpcListener(args, credential)
    credential = None  # drop the local reference; listener holds memory

    def on_signal(signum, frame):
        listener.stop_event.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        return listener.run_forever()
    finally:
        try:
            if os.path.exists(listener.pid_path):
                os.unlink(listener.pid_path)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
