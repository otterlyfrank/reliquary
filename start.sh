#!/usr/bin/env bash
# Reliquary — one-command local start (Mac / Linux)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8780}"
URL="http://127.0.0.1:${PORT}/"

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

already_proxy() {
  curl -sS --max-time 0.6 "${URL}api/llm/status" 2>/dev/null | grep -q '"proxy": true'
}

open_page() {
  if [[ "${RELIQUARY_NO_OPEN:-}" == "1" ]]; then
    return 0
  fi
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
}

if already_proxy && [[ "${GIT_UPDATED}" != "1" ]]; then
  echo ""
  echo "  Reliquary is already running"
  echo "  Open: ${URL}"
  echo ""
  open_page
  exit 0
fi
if already_proxy && [[ "${GIT_UPDATED}" == "1" ]]; then
  echo "  New GitHub commit on disk — restarting Reliquary."
fi

# Take over a stale python -m http.server (or hung listener) on our port.
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "  Port ${PORT} was busy with an old Reliquary server — restarting it cleanly."
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.4
  fi
fi

# Open the browser only after HTTP actually answers (no splash-of-connection-refused).
(
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
    if curl -sS -o /dev/null --max-time 0.3 "$URL" 2>/dev/null; then
      open_page
      exit 0
    fi
    sleep 0.12
  done
) &

export PORT
export PYTHONUNBUFFERED=1
exec python3 -u serve.py
