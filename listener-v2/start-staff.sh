#!/bin/bash
# start-staff.sh — 1 lenh chay listener v2 staff mode (Pha 1).
#
# Dung (trong thu muc listener-v2/):
#   ./start-staff.sh --email ban@aicompany.app \
#       --self-names "Ten,TenKhongDau" --self-sender-id <sender-id-cua-ban>
#
# Script chi lam 4 viec, khong giu secret:
#   1. Kiem tra python3 + file listener_v2.py.
#   2. Kiem tra google-cloud-firestore; thieu thi pip install 1 lan.
#   3. Lay API key public: env FIREBASE_API_KEY, neu trong thi lay tu
#      config web cong khai (raw.githubusercontent.com/.../main/config.js).
#   4. exec listener_v2.py --mode staff voi dung tham so da truyen.
# Ma truy cap KHONG qua script: listener tu hoi qua stdin (go 1 lan,
# khong luu). Dung dung sender-id ban da dung o v1; neu email khac
# mau thi dung email ban da dung o v1.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

command -v python3 >/dev/null 2>&1 || {
  echo "Thieu python3 — cai python3 roi chay lai." >&2; exit 1; }
[ -f "$DIR/listener_v2.py" ] || {
  echo "Thieu listener_v2.py — tai thu muc listener-v2/ tu repo chungdenroi/ai-company-web (nhanh main) ve roi chay lai." >&2
  exit 1; }
python3 -c "import google.cloud.firestore" 2>/dev/null || {
  echo "Dang cai google-cloud-firestore..."
  python3 -m pip install --user google-cloud-firestore || {
    echo "Cai that bai — chay tay: python3 -m pip install google-cloud-firestore" >&2
    exit 1; }
}
if [ -z "${FIREBASE_API_KEY:-}" ]; then
  KEY="$(curl -fsSL https://raw.githubusercontent.com/chungdenroi/ai-company-web/main/config.js 2>/dev/null \
    | grep -o 'apiKey: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/')"
  if [ -z "$KEY" ]; then
    echo "Khong lay duoc FIREBASE_API_KEY tu config web — export FIREBASE_API_KEY roi chay lai." >&2
    exit 1
  fi
  export FIREBASE_API_KEY="$KEY"
fi
exec python3 "$DIR/listener_v2.py" --mode staff "$@"
