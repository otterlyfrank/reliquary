#!/usr/bin/env bash
# Start Reliquary’s local server if needed, then open the installed window.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8780}"
URL="http://127.0.0.1:${PORT}/"
LOG="${TMPDIR:-/tmp}/reliquary-serve.log"
PWA="${HOME}/Applications/Brave Browser Apps.localized/Reliquary.app"
LABEL="gui/${UID}/com.otterly.reliquary"

up() {
  curl -sS -o /dev/null --max-time 0.5 "${URL}health" 2>/dev/null \
    || curl -sS -o /dev/null --max-time 0.5 "$URL" 2>/dev/null
}

start_server() {
  if launchctl print "$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$LABEL" 2>/dev/null || true
    return 0
  fi
  cd "$ROOT"
  nohup python3 -u serve.py >>"$LOG" 2>&1 &
}

open_window() {
  if [[ -d "$PWA" ]]; then
    open "$PWA" 2>/dev/null && return 0
  fi
  if [[ -d "/Applications/Brave Browser.app" ]]; then
    open -na "Brave Browser" --args --app="$URL" 2>/dev/null && return 0
  fi
  open "$URL" 2>/dev/null || true
}

if ! up; then
  start_server
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if up; then
      break
    fi
    sleep 0.15
  done
fi

if ! up; then
  echo "Reliquary server did not start. Log: $LOG" >&2
  tail -20 "$LOG" 2>/dev/null || true
  exit 1
fi

open_window
