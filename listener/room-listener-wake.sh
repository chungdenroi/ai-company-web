#!/usr/bin/env bash
# Hook: wake the coordinator when the room listener detects new events.
# Reads the listener's local JSONL event log (no credentials, no network,
# no Firestore reads). State = last consumed line number, kept by the
# hook runtime (writes are skipped automatically on dry runs).
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

EVENT_LOG="${ROOM_EVENT_LOG:-$HOME/workspace/ai-company/listener/events.jsonl}"

state="$(hook_state_get)"
last_line="$(printf '%s' "$state" | jq -r '.last_line // 0')"
if ! [[ "$last_line" =~ ^[0-9]+$ ]]; then
    last_line=0
fi

if [[ ! -f "$EVENT_LOG" ]]; then
    silent "no event log yet"
fi

# Collect valid JSON lines after $last_line. Stop at the first invalid
# line: the listener may be mid-write on the trailing line; that line
# stays for the next poll (offset does not advance past it).
valid_lines=""
consumed=0
lineno=0
while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    if (( lineno <= last_line )); then
        continue
    fi
    if printf '%s' "$line" | jq -e . >/dev/null 2>&1; then
        valid_lines+="$line"$'\n'
        consumed=$((consumed + 1))
    else
        break
    fi
done <"$EVENT_LOG"

if (( consumed == 0 )); then
    silent "no new room events"
fi

new_last_line=$((last_line + consumed))
events_json="$(printf '%s' "$valid_lines" | jq -s -c \
    '[.[] | {event_id, ts, sender_name, kind, reason,
              content: .content[0:500]}] | .[0:10]')"
payload="$(jq -cn \
    --argjson first_line "$((last_line + 1))" \
    --argjson count "$consumed" \
    --argjson events "$events_json" \
    '{first_line: $first_line, count: $count, events: $events}')"
hook_state_set "$(jq -cn --argjson n "$new_last_line" '{last_line: $n}')"
wake "room-listener" "$payload"
