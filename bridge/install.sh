#!/bin/sh
# Installs the Receipts bridge as a LaunchAgent for the current macOS user.
# Run it from the repo while logged in as the dedicated "Receipts Bot" macOS user.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/ReceiptsBridge"
LOG_DIR="$HOME/Library/Logs/ReceiptsBridge"
PLIST="$HOME/Library/LaunchAgents/com.receipts.bridge.plist"
ENV_FILE="$HOME/.receipts-bridge.env"

NODE="$(command -v node || true)"
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20 or later is required for this macOS user." >&2
  exit 1
fi

cd "$REPO"
npm install --no-audit --no-fund
npm run bridge:build

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
cp bridge/dist/receipts-bridge.mjs "$INSTALL_DIR/receipts-bridge.mjs"

if [ ! -f "$ENV_FILE" ]; then
  cp bridge/receipts-bridge.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Fill it in, then run this script again."
  exit 0
fi
chmod 600 "$ENV_FILE"

if ! "$NODE" "$INSTALL_DIR/receipts-bridge.mjs" check; then
  echo "Fix the settings in $ENV_FILE (or start BlueBubbles), then run this script again." >&2
  exit 1
fi

sed -e "s|__NODE__|$NODE|" -e "s|__INSTALL_DIR__|$INSTALL_DIR|" -e "s|__LOG_DIR__|$LOG_DIR|" \
  bridge/launchd/com.receipts.bridge.plist > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Receipts bridge installed and running."
echo "Logs: $LOG_DIR/bridge.log"
