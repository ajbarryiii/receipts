# Receipts Lakebed capsule

The web app, database, and bridge API for Receipts. Read `AGENTS.md` before changing files.

```sh
npx lakebed dev      # http://localhost:3000
npx lakebed deploy
```

## Layout

- `server/schema.ts`: tables and indexes.
- `server/index.ts`: the `capsule()` definition that wires queries, mutations, and bot endpoints.
- `server/bot.ts`: chat commands, receipt capture and nominations, chat settlement, reminders, Take Blitz announcements.
- `server/jev.ts`: calls TypeSafe's Jev to grade blitz takes for their temp checks. The questions, levels, and
  temperature weights are in `shared/jev.ts`.
- `server/web.ts`: web views and mutations. Every one requires Google sign-in and group membership.
- `server/model.ts`: shared row helpers (names, cards, identity linking, Take Blitz scoring and the crown).
- `shared/`: pure logic shared with the client and the bridge. `bot-api.ts` is the bridge contract. `guide.ts` holds the
  homepage's command examples, which tests run through the parser.
- `client/`: Preact pages (`/`, `/how-it-works`, `/join/:token`, `/g/:groupId`, `/g/:groupId/r/:number`, `/g/:groupId/p/:subjectRef`).

## Bot API

Every route requires `Authorization: Bearer <RECEIPTS_BOT_SECRET>`.

| Route | Purpose |
| --- | --- |
| `GET /api/bot/ping` | Health check. |
| `POST /api/bot/message` | Submit one `@receipts` message (optionally with `replyTo`). Idempotent on `messageGuid`; returns the reply to send. |
| `POST /api/bot/message/ack` | Confirm the reply was sent. |
| `GET /api/bot/due` | Up to 20 due reminders that haven't been acknowledged. |
| `POST /api/bot/reminded` | Confirm a reminder was sent. |
| `GET /api/bot/announcements` | Up to 20 Take Blitz announcements ready to post. Superseded ones are left out. |
| `POST /api/bot/announced` | Confirm an announcement was sent (also retires anything it superseded). |

## Server env (`.env.lakebed.server`, never committed)

- `RECEIPTS_BOT_SECRET` (required, 24+ characters): shared with the bridge.
- `APP_URL` (recommended): public origin used in links the bot sends.
- `TYPESAFE_API_KEY` (optional): turns on instant temp checks for blitz takes. Without it, blitz takes go unchecked.

Server code must stay compatible with Lakebed's anonymous-code scan: no `while` loops, `globalThis`, timers, or
`process`. `npx lakebed build --target anonymous` checks this. Its one expected complaint is the outbound `fetch` in
`server/jev.ts`, which claimed deploys allow.
