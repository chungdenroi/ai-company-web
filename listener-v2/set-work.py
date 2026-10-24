#!/usr/bin/env python3
"""CLI 1 lenh bao viec (Pha 1): set_work gop presence + the + tin.

Dung (trong thu muc listener-v2/):
  python3 set-work.py --email ban@aicompany.app --sender-id <id> \\
      --sender-name "<ten>" --work "dang lam gi" \\
      [--task-id <id-viec>] [--progress "50%"] [--blocker "ket gi"] \\
      [--employee-doc <id-doc-neu-khac-sender>]

Ma truy cap: go khi script hoi (getpass, khong hien, khong luu).
API key: env FIREBASE_API_KEY, neu trong thi tu lay tu config web
cong khai (raw.githubusercontent.com/.../main/config.js).
Project mac dinh: ai-company-a51da.

AN TOAN: token/ma chi trong RAM cua lan chay; khong log secret;
429 -> dung ngay, doi 600s moi goi lai (khong retry dot dot).
"""

from __future__ import annotations

import argparse
import getpass
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sender import RateLimited, SendError, set_work, sign_in  # noqa: E402

PROJECT_DEFAULT = "ai-company-a51da"
CONFIG_URL = ("https://raw.githubusercontent.com/chungdenroi/"
              "ai-company-web/main/config.js")


def _utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _api_key_from_web():
    try:
        with urllib.request.urlopen(CONFIG_URL, timeout=15) as resp:
            text = resp.read().decode("utf-8")
    except Exception:
        return ""
    m = re.search(r'apiKey:\s*"([^"]+)"', text)
    return m.group(1) if m else ""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Bao viec 1 lenh (set_work).")
    ap.add_argument("--email", required=True)
    ap.add_argument("--sender-id", required=True)
    ap.add_argument("--sender-name", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--task-id", default="")
    ap.add_argument("--progress", default="")
    ap.add_argument("--blocker", default="")
    ap.add_argument("--employee-doc", default="")
    ap.add_argument("--project", default=PROJECT_DEFAULT)
    args = ap.parse_args(argv)

    import os
    api_key = os.environ.get("FIREBASE_API_KEY", "").strip()
    if not api_key:
        api_key = _api_key_from_web()
    if not api_key:
        print("Khong co FIREBASE_API_KEY va khong lay duoc tu config web. "
              "Export FIREBASE_API_KEY roi chay lai.", file=sys.stderr)
        return 2

    code = getpass.getpass("Ma truy cap: ").strip()
    if not code:
        print("Ma rong — dung.", file=sys.stderr)
        return 2
    try:
        token, _ = sign_in(api_key, args.email, code)
        out = set_work(args.project, token, args.employee_doc,
                       args.sender_id, args.sender_name, args.work,
                       task_id=args.task_id, progress=args.progress,
                       blocker=args.blocker, now_iso=_utc_now_iso())
    except RateLimited:
        print("Bi gioi han 429 — dung ngay, doi 600s moi goi lai.",
              file=sys.stderr)
        return 3
    except SendError as exc:
        print(f"Loi: {exc}", file=sys.stderr)
        return 1
    print("Da day:")
    print(f"  presence + the: {out['presence'] and out['employee']}")
    print(f"  tin trang thai: {out['message']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
