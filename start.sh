#!/usr/bin/env bash
# Reliquary — start the local server in the background, then open the vault.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
cd "$(dirname "$0")"
PORT="${PORT:-8780}"
URL="http://127.0.0.1:${PORT}/"
LOG="${TMPDIR:-/tmp}/reliquary-serve.log"
PID_FILE="${TMPDIR:-/tmp}/reliquary-serve.pid"
PWA="${HOME}/Applications/Brave Browser Apps.localized/Reliquary.app"
LABEL="gui/${UID:-$(id -u)}/com.otterly.reliquary"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install from https://www.python.org/downloads/" >&2
  exit 1
fi

GIT_UPDATED=0
if [[ "${SKIP_GIT_PULL:-0}" != "1" && -d .git ]]; then
  SUITE_PULL="$(cd "$(dirname "$0")/../otterly-suite" 2>/dev/null && pwd)/git-pull.sh"
  if [[ -f "$SUITE_PULL" ]]; then
    # shellcheck disable=SC1090
    source "$SUITE_PULL"
    otterly_git_pull "."
    GIT_UPDATED="${OTTERLY_GIT_UPDATED:-0}"
  fi
fi

up() {
  curl -sS -o /dev/null --max-time 0.6 "${URL}health" 2>/dev/null \
    || curl -sS -o /dev/null --max-time 0.6 "$URL" 2>/dev/null
}

open_page() {
  if [[ "${RELIQUARY_NO_OPEN:-}" == "1" ]]; then
    return 0
  fi
  if [[ -d "$PWA" ]]; then
    open "$PWA" >/dev/null 2>&1 && return 0
  fi
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
}

if up && [[ "${GIT_UPDATED}" != "1" ]]; then
  echo ""
  echo "  Reliquary is already running"
  echo "  Open: ${URL}"
  echo ""
  open_page
  exit 0
fi

if up && [[ "${GIT_UPDATED}" == "1" ]]; then
  echo "  New GitHub commit on disk — restarting Reliquary."
fi

if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "  Stopping the old process on :${PORT}"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.4
  fi
fi

export PORT
export PYTHONUNBUFFERED=1

if launchctl print "$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$LABEL" 2>/dev/null || true
else
  nohup python3 -u serve.py >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
fi

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if up; then
    ready=1
    break
  fi
  sleep 0.15
done

if [[ "$ready" -ne 1 ]]; then
  echo "Reliquary did not start on ${URL}" >&2
  echo "Log: ${LOG}" >&2
  tail -20 "$LOG" 2>/dev/null || true
  exit 1
fi

echo ""
echo "  Reliquary — writing archaeology"
echo "  Open: ${URL}"
echo "  Running in the background (like Otterly Leads)."
echo "  Stop: lsof -ti :${PORT} | xargs kill"
echo ""
open_page
