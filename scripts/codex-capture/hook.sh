#!/bin/sh
# Capture hook for Codex. Usage: hook.sh <outdir> [allow|deny|slow-allow]
# Saves the stdin payload (and AGENT_BOARD_*/CODEX_* env) to <outdir>/<ns>.json|.env.
# With a decision argument it also answers a PermissionRequest.
out="$1"; mkdir -p "$out"
ts=$(python3 -c 'import time;print(time.time_ns())')
case "$2" in
  "{"*) printf '%s' "$2" > "$out/$ts.json"; exit 0 ;;  # legacy notify: JSON arrives as argv
esac
cat > "$out/$ts.json"
env | grep -E '^(CODEX|PWD|AGENT_BOARD)' > "$out/$ts.env" 2>/dev/null
case "$2" in
  slow-allow) sleep 15 ;;
esac
case "$2" in
  allow|slow-allow) echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' ;;
  deny) echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"denied by capture hook"}}}' ;;
esac
exit 0
