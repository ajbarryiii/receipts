# 🧾 Receipts

An iMessage-native record book for friend groups. Say `@receipts` in a group chat to lock in a take, promise, bet, or
conditional. The bot resurfaces it in the same chat when it comes due, and a web app keeps the standings.

```text
iMessage group ──▶ Messages.app ──▶ BlueBubbles ──▶ bridge (Mac) ──HTTPS──▶ Lakebed app
                                                       ▲                       │
                                                       └── replies/reminders ──┘
```

- **Lakebed app** (`app/`) owns everything durable: parsing, receipts, groups, identities, heat votes, scoring,
  settlement, the website, and the HTTP API for the bridge.
- **Mac bridge** (`bridge/`) is a thin transport. It forwards only `@receipts` messages, sends replies, reminders, and
  announcements back, and catches up after the Mac sleeps. Its only local state is a cursor and an acknowledgement queue.

## Using it in a group chat

| Message | What happens |
| --- | --- |
| `@receipts #take Dana says the Giants win the division by Oct 1 2027` | Logs a take about Dana (a "recorded claim"). |
| Native **Reply** to someone's message: `@receipts #take by Apr 15 2027` | Nominates their exact message. They must accept it before it's official. |
| Reply to your own message: `@receipts #take by Apr 15` | Puts your message on the record immediately. |
| Reply to someone's old message: `@receipts exposed` | Puts it on the record as their take right away, no accepting. Anyone but them and you can settle it. |
| Reply to your own old message: `@receipts told you so` (or `called it`) | Claims you called it. Someone else confirms it. |
| `@receipts accept 43` / `@receipts reject 43` | The nominated message's author answers a nomination. |
| `@receipts 43 right` / `wrong` / `void` | Settles #43 any time. Also `kept`/`broken`, `won`/`lost`, `fulfilled`/`not fulfilled`. The take's author and its nominator can't settle it. |
| `#promise`, `#bet`, `#conditional`, or no tag | Other receipt types. Untagged receipts are inferred. |
| `@receipts upcoming` · `list` · `nominations` · `mine` · `43` | Look things up. |
| `@receipts cancel 43` | Whoever logged it can cancel within 24 hours. |
| `@receipts call me Ace` | Sets how the bot names you, no account needed. |
| `@receipts join` | 15-minute link to connect your texts to a web account. |
| `@receipts setup` | 7-day invite link to the group's record book. |
| `@receipts lfg` | Starts the group's one-time Take Blitz (below), with the record book invite. |

On the website, members rate the heat of takes (1–5 🔥, median wins, locked at settlement), settle receipts, accept or
reject nominations, and browse standings and profiles. A correct take earns 1/2/4/7/12 points by heat. Only the group
owner can change an outcome after it's settled, and never on their own take.

### Take Blitz

`@receipts lfg` opens a 24-hour window to get a group's library of takes going. Every take someone logs about
themselves during the window earns blitz points: 4 if it's due today or tomorrow, 2 if it's due before the crown is
anointed (7 days after `lfg`), nothing otherwise. Undated takes are due the day before the anointing. A wrong take keeps
half its points and a void one keeps none. Old takes count too, for a flat 2 with no timing bonus: `told you so` works
like any blitz take, and `exposed` costs the author 2 if their old take is settled wrong (nothing if it was right or
never gets settled). Each person's first 10 takes, told-you-sos, and exposés score; later ones are still logged.

When the window closes, the bot posts the board and the leader gets the 👑 for now. The crown changes hands as takes
settle. A day before the anointing the bot posts a last call listing unsettled blitz takes. At the anointing, unsettled
takes keep half and the result is final. Whoever wears the crown gets a 👑 next to their name in bot messages and on the
website. Blitz points never count toward Take Score. Each group gets one blitz.

Guardrails: a message can only be captured once (a second `@receipts` reply to it points at the existing receipt), and
the same open take about the same person with the same deadline isn't logged twice.

## Repository layout

```text
app/                 Lakebed capsule (see app/README.md)
  server/            schema, bot API, web queries/mutations
  shared/            pure logic: parser, dates, scoring, bot copy, bridge API contract
  client/            Preact web app
bridge/              Mac bridge (see bridge/README.md)
tests/               app tests (shared logic + server handlers on Lakebed's in-memory runtime)
bridge/test/         bridge tests
```

## Development

Requires Node.js 20+.

```sh
npm install
npm test            # all tests
npm run typecheck   # app, client, tests, bridge
npm run dev         # lakebed dev for the app on http://localhost:3000
npm run bridge:build
```

For local bot testing, put a secret in `app/.env.lakebed.server` (gitignored):

```text
RECEIPTS_BOT_SECRET=<at least 24 random characters>
```

The website requires Google sign-in, which works in `lakebed dev` on localhost.

## Deploy

1. **Deploy the app.** From `app/`: `npx lakebed auth login`, then `npx lakebed deploy`, then commit the generated
   `app/lakebed.json`. The bot secret only reaches hosted Lakebed once the deploy is claimed.
2. **Set secrets.** In `app/.env.lakebed.server` set `RECEIPTS_BOT_SECRET` and `APP_URL`
   (e.g. `https://receipts.lakebed.app`, used in links the bot sends). Run `npx lakebed deploy` again to sync them.
3. **Optional:** `npx lakebed domains add <name>.lakebed.app`.
4. **Set up the Mac and bridge** as described in [bridge/README.md](bridge/README.md).
5. Add the Receipts Apple Account to your group chat and send `@receipts lfg` to start the Take Blitz (or
   `@receipts setup` for just the record book invite).

## Limits worth knowing

- Lakebed's free plan allows 1 MiB of stored data, 1,000 mutations a day, and 10,000 requests a day. A four-person
  group fits comfortably. Every processed `@receipts` message uses one or two mutations.
- Standings are computed from each group's latest 500 receipts.
- iMessage records only the **first** message of a reply thread as the reply target. If the thread already has other
  replies, the bot can't tell which message you meant and asks you to spell the take out
  (`@receipts #take <name>: <the take> by <date>`).
