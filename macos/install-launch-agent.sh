#!/usr/bin/env bash
# Keep Reliquary’s localhost server running so the Dock icon can open it.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${HOME}/Library/LaunchAgents/com.otterly.reliquary.plist"
LABEL="gui/${UID}/com.otterly.reliquary"
PY="$(python3 -c 'import sys; print(sys.executable)')"

mkdir -p "${HOME}/Library/LaunchAgents"

cat > "$DEST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.otterly.reliquary</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PY}</string>
    <string>-u</string>
    <string>${ROOT}/serve.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>8780</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/reliquary-serve.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/reliquary-serve.log</string>
</dict>
</plist>
EOF

: > /tmp/reliquary-serve.log
launchctl bootout "$LABEL" 2>/dev/null || true
sleep 0.2
launchctl bootstrap "gui/${UID}" "$DEST"
launchctl enable "$LABEL"
launchctl kickstart -k "$LABEL"

echo "Reliquary server will stay running on http://127.0.0.1:8780"
echo "  python: $PY"
echo "  launch agent: $DEST"
echo "  stop: launchctl bootout $LABEL"
