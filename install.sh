#!/bin/bash
# phone-remote installer —— build the .app wrapper + install the LaunchAgent.
#
# Why a .app wrapper instead of running `node server.js` from launchd directly:
# macOS grants Accessibility (needed to synthesize keystrokes) per *executable*.
# A launchd job pointing at /opt/homebrew/bin/node would have to be re-authorized
# whenever Homebrew bumps node's Cellar path, and that binary is awkward to pick
# in the Accessibility file picker. A signed .app in ~/Applications is easy to add
# and keeps a stable TCC identity.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Applications/PhoneRemote.app"
LABEL="${PR_LABEL:-com.example.phone-remote}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/ops-logs/phone-remote"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "error: node not found in PATH"; exit 1; }
command -v clang >/dev/null || { echo "error: clang not found (install Xcode Command Line Tools)"; exit 1; }

echo "==> repo:  $REPO_DIR"
echo "==> node:  $NODE_BIN"
echo "==> label: $LABEL"

# ── 1. build the .app wrapper ──────────────────────────────────────────────
mkdir -p "$APP_DIR/Contents/MacOS" "$LOG_DIR"
TMP_C="$(mktemp -t pr_launcher).c"
cat > "$TMP_C" <<C
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
int main(void) {
    if (chdir("$REPO_DIR") != 0) perror("chdir");
    setenv("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", 1);
    execl("$NODE_BIN", "node", "$REPO_DIR/server.js", (char *)NULL);
    perror("execl node");
    return 1;
}
C
clang -O2 -o "$APP_DIR/Contents/MacOS/PhoneRemote" "$TMP_C"
mv "$TMP_C" "$TMPDIR/" 2>/dev/null || true

cat > "$APP_DIR/Contents/Info.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Phone Remote</string>
  <key>CFBundleDisplayName</key><string>Phone Remote</string>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleExecutable</key><string>PhoneRemote</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLISTEOF

codesign --force --deep --sign - "$APP_DIR"
echo "==> built + signed $APP_DIR"

# ── 2. install the LaunchAgent ─────────────────────────────────────────────
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$APP_DIR/Contents/MacOS/PhoneRemote</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLISTEOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2

echo "==> launchd state:"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s*(state|pid|runs) " || true
echo
echo "==> health:"
curl -s -m 5 http://127.0.0.1:8787/health || echo "(not responding yet)"
echo
cat <<'NEXT'

────────────────────────────────────────────────────────────
ONE MANUAL STEP LEFT — grant Accessibility (required to send keys):

  System Settings → Privacy & Security → Accessibility
  → click "+" → Applications → pick "Phone Remote" → toggle ON

Then restart the agent:
  launchctl kickstart -k "gui/$(id -u)/<label>"

The phone URL (with token) is printed in:
  ~/ops-logs/phone-remote/stdout.log
────────────────────────────────────────────────────────────
NEXT
