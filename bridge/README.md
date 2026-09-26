# Receipts bridge

A small Node.js daemon that connects BlueBubbles on a Mac to the Receipts Lakebed app. It has no product logic.

## What it does

1. Receives BlueBubbles `new-message` webhooks on `127.0.0.1`.
2. Drops everything except messages from other people that contain `@receipts`. Tapbacks, the bot's own messages, and
   one-to-one chats (unless allowed) never leave the Mac.
3. If an `@receipts` message is a native iMessage reply, looks up **that one** replied-to message in BlueBubbles
   (`threadOriginatorGuid` → `GET /api/v1/message/:guid`) and attaches its text, author, and timestamp. It also checks
   locally whether the thread already had other replies. iMessage only records a thread's first message, so in that
   case it marks the reply `ambiguous` and Lakebed asks for the take to be spelled out. Thread messages are never sent.
4. `POST /api/bot/message` to Lakebed, sends any reply into the same chat, then acknowledges it.
5. Every hour (and on startup and wake) fetches due reminders, sends them, and acknowledges each one.
6. Every 5 minutes (and on startup, wake, and BlueBubbles restarts) scans BlueBubbles for messages after its ROWID
   cursor, so nothing is lost while the Mac slept or the webhook was missed.
7. Every 5 minutes (and on startup and wake) fetches group announcements (Take Blitz news), sends them, and
   acknowledges each one.

Retries are safe. Lakebed deduplicates on the message GUID and keeps each reply until the bridge acknowledges it. The
bridge records "sent but not yet acknowledged" locally, so a restart never resends a reply, reminder, or announcement.

## One-time Mac setup

1. **Create a macOS user** named "Receipts Bot" (System Settings → Users & Groups).
2. **Create a dedicated Apple Account** (e.g. `receiptsbot@icloud.com`). Sign into Messages with it in the Receipts
   Bot user only. Your own user keeps your personal account.
3. In the Receipts Bot user, install **BlueBubbles Server** (https://bluebubbles.app) and complete its setup:
   - Set a server password. Leave the Private API **off**; SIP stays enabled.
   - Enable "Start BlueBubbles when you log in".
   - Under **API & Webhooks**, add a webhook
     `http://127.0.0.1:8787/bluebubbles?secret=<BRIDGE_WEBHOOK_SECRET>` for **New Messages** (and **Hello World** if
     listed; the bridge ignores everything else).
4. Install Node.js 20+ for the Receipts Bot user and clone this repository.
5. Run `bridge/install.sh`. The first run creates `~/.receipts-bridge.env` (mode 600); fill it in using
   [receipts-bridge.env.example](receipts-bridge.env.example) and run `install.sh` again. It builds
   `receipts-bridge.mjs`, checks both connections, and installs the `com.receipts.bridge` LaunchAgent (starts at login,
   restarts on crash).
6. Stay logged into the Receipts Bot user and use Fast User Switching to go back to your own account. After a reboot, log
   into the Receipts Bot user once.

Logs: `~/Library/Logs/ReceiptsBridge/bridge.log`. Check connectivity any time with
`node "$HOME/Library/Application Support/ReceiptsBridge/receipts-bridge.mjs" check`.

## Local state

`~/Library/Application Support/ReceiptsBridge/state.json` holds the catch-up cursor, recently handled message GUIDs, and
owed acknowledgements. Deleting it is safe: the next scan looks back 24 hours and Lakebed ignores duplicates.

## Development

```sh
npm test               # includes bridge/test
npm run bridge:build   # bundles bridge/src/main.ts into bridge/dist/receipts-bridge.mjs
```
