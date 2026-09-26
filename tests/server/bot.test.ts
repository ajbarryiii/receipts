import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import type { DueResponse } from "../../app/shared/bot-api";
import { dueAtFor } from "../../app/shared/dates";
import {
  canceledMessage,
  confirmationMessage,
  helpMessage,
  maskHandle,
  receiptDetailMessage,
  receiptListMessage,
  settledMessage,
  setupMessage
} from "../../app/shared/format";
import { account, APP_URL, BOT_SECRET, CHAT, CONNOR_HANDLE, JR_HANDLE, OTHER_CHAT, TestApp, tokenFrom } from "./harness";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Noon PDT on Friday, Sep 25 2026.
const NOON = Date.UTC(2026, 8, 25, 19, 0);

function useClock(t: TestContext, start = NOON) {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

const TAKE = "@receipts #take JR says the Giants win the division by Oct 1 2027";

let app: TestApp;

beforeEach(() => {
  app = new TestApp();
});

async function onlyGroupId(): Promise<string> {
  const groups = await app.rows("groups");
  assert.equal(groups.length, 1);
  return groups[0].id as string;
}

describe("bot endpoint authentication", () => {
  it("rejects missing and wrong secrets", async () => {
    assert.equal((await app.request("GET", "/api/bot/ping")).status, 401);
    const wrong = await app.request("GET", "/api/bot/ping", { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const wrongScheme = await app.request("GET", "/api/bot/ping", { headers: { Authorization: BOT_SECRET } });
    assert.equal(wrongScheme.status, 401);
  });

  it("fails closed when the secret is not configured", async () => {
    const unconfigured = new TestApp({ APP_URL });
    const response = await unconfigured.request("GET", "/api/bot/ping", { headers: { Authorization: "Bearer " } });
    assert.equal(response.status, 503);
  });

  it("answers an authenticated ping", async (t) => {
    useClock(t);
    assert.deepEqual(await app.bot("GET", "/api/bot/ping"), { status: 200, body: { ok: true, now: NOON } });
  });

  it("rejects malformed message payloads", async () => {
    const response = await app.request("POST", "/api/bot/message", {
      rawBody: "{not json",
      headers: { Authorization: `Bearer ${BOT_SECRET}` }
    });
    assert.equal(response.status, 400);
    assert.equal((await app.bot("POST", "/api/bot/message", { text: "@receipts" })).status, 400);
  });
});

describe("logging receipts from chat", () => {
  it("ignores and stores nothing for messages without a mention", async (t) => {
    useClock(t);
    const result = await app.chat("lol JR is wrong again");
    assert.equal(result.status, "ignored");
    assert.equal(result.reply, null);
    assert.equal((await app.rows("groups")).length, 0);
    assert.equal((await app.rows("processedMessages")).length, 0);
  });

  it("logs a take and replies with a confirmation", async (t) => {
    useClock(t);
    const result = await app.chat(TAKE);
    assert.equal(result.status, "processed");
    assert.equal(
      result.reply,
      confirmationMessage(
        {
          number: 1,
          type: "take",
          status: "pending",
          capture: "manual",
          subjectName: "JR",
          statement: "The Giants win the division",
          madeOn: "2026-09-25",
          deadline: "2027-10-01",
          dateAmbiguous: false,
          heat: null
        },
        { today: "2026-09-25", late: false }
      )
    );

    const [group] = await app.rows("groups");
    assert.equal(group.name, "The Boys");
    assert.equal(group.chatGuid, CHAT);

    const [receipt] = await app.rows("receipts");
    assert.equal(receipt.groupId, group.id);
    assert.equal(receipt.number, 1);
    assert.equal(receipt.type, "take");
    assert.equal(receipt.status, "pending");
    assert.equal(receipt.subjectName, "JR");
    assert.equal(receipt.subjectKey, "jr");
    assert.equal(receipt.statement, "The Giants win the division");
    assert.equal(receipt.originalText, TAKE);
    assert.equal(receipt.commandMessageGuid, result.messageGuid);
    assert.equal(receipt.capture, "manual");
    assert.equal(receipt.sourceMessageGuid, undefined);
    assert.equal(receipt.madeOn, "2026-09-25");
    assert.equal(receipt.deadline, "2027-10-01");
    assert.equal(receipt.dueAt, dueAtFor("2027-10-01", -420));
    assert.equal(receipt.subjectUserId, undefined);
    assert.equal(typeof receipt.createdByIdentityId, "string");
  });

  it("is idempotent and repeats the reply until it is acknowledged", async (t) => {
    useClock(t);
    const first = await app.chat(TAKE, { messageGuid: "dup-1" });
    const second = await app.chat(TAKE, { messageGuid: "dup-1" });
    assert.equal(second.status, "duplicate");
    assert.equal(second.reply, first.reply);
    assert.equal((await app.rows("receipts")).length, 1);

    assert.deepEqual(await app.bot("POST", "/api/bot/message/ack", { messageGuid: "dup-1" }), { status: 200, body: { ok: true } });
    assert.deepEqual(await app.bot("POST", "/api/bot/message/ack", { messageGuid: "dup-1" }), { status: 200, body: { ok: true } });
    const third = await app.chat(TAKE, { messageGuid: "dup-1" });
    assert.equal(third.status, "duplicate");
    assert.equal(third.reply, null);

    const [ledger] = await app.rows("processedMessages");
    assert.equal(ledger.reply, undefined);
    assert.equal(typeof ledger.repliedAt, "number");
  });

  it("returns 404 when acknowledging an unknown message", async () => {
    assert.equal((await app.bot("POST", "/api/bot/message/ack", { messageGuid: "nope" })).status, 404);
    assert.equal((await app.bot("POST", "/api/bot/message/ack", {})).status, 400);
  });

  it("numbers receipts per group", async (t) => {
    useClock(t);
    await app.chat(TAKE);
    const second = await app.chat("@receipts Connor says OpenAI IPOs before 2028");
    const otherGroup = await app.chat(TAKE, { chatGuid: OTHER_CHAT, chatName: "Work" });
    assert.match(second.reply ?? "", /Receipt #2/);
    assert.match(otherGroup.reply ?? "", /Receipt #1/);
    assert.equal((await app.rows("groups")).length, 2);
  });

  it("masks unlinked senders who are the subject", async (t) => {
    useClock(t);
    const result = await app.chat("@receipts I say the Giants win the division by Oct 1 2027");
    assert.match(result.reply ?? "", new RegExp(`${maskHandle(JR_HANDLE)}:`));
    const [receipt] = await app.rows("receipts");
    const [identity] = await app.rows("identities");
    assert.equal(receipt.subjectName, maskHandle(JR_HANDLE));
    assert.equal(receipt.subjectIdentityId, identity.id);
  });

  it("flags late confirmations when catching up", async (t) => {
    useClock(t);
    const result = await app.chat(TAKE, { sentAt: NOON - 8 * HOUR });
    assert.equal(result.status, "processed");
    assert.match(result.reply ?? "", /offline/);
  });

  it("uses the sender's local date for relative deadlines", async (t) => {
    useClock(t);
    // 11pm PDT on Sep 24, processed at noon on Sep 25.
    await app.chat("@receipts JR says the Giants win by tomorrow", { sentAt: Date.UTC(2026, 8, 25, 6, 0) });
    const [receipt] = await app.rows("receipts");
    assert.equal(receipt.madeOn, "2026-09-24");
    assert.equal(receipt.deadline, "2026-09-25");
  });

  it("explains how to log a receipt when there is nothing to record", async (t) => {
    useClock(t);
    const result = await app.chat("@receipts #take");
    assert.equal(result.status, "processed");
    assert.match(result.reply ?? "", /Tell me what to lock in/);
    assert.equal((await app.rows("receipts")).length, 0);
  });

  it("keeps only reply text, not chat text, for commands", async (t) => {
    useClock(t);
    await app.chat("@receipts list");
    const [ledger] = await app.rows("processedMessages");
    assert.equal(JSON.stringify(ledger).includes("@receipts list"), false);
  });
});

describe("chat commands", () => {
  it("replies to help with the group link", async (t) => {
    useClock(t);
    const result = await app.chat("@receipts help");
    assert.equal(result.reply, helpMessage(`${APP_URL}/g/${await onlyGroupId()}`));
  });

  it("lists pending receipts newest first", async (t) => {
    useClock(t);
    await app.chat(TAKE);
    await app.chat("@receipts Connor says OpenAI IPOs before 2028", { senderHandle: CONNOR_HANDLE });
    const result = await app.chat("@receipts list");
    const reply = result.reply ?? "";
    assert.match(reply, /PENDING/);
    assert.ok(reply.indexOf("#2 Connor") < reply.indexOf("#1 JR"));
  });

  it("lists upcoming deadlines soonest first", async (t) => {
    useClock(t);
    await app.chat(TAKE);
    await app.chat("@receipts Connor says OpenAI IPOs before 2027");
    await app.chat("@receipts JR said pineapple pizza is elite");
    const reply = (await app.chat("@receipts upcoming")).reply ?? "";
    assert.match(reply, /UPCOMING/);
    assert.ok(reply.indexOf("#2 Connor") < reply.indexOf("#1 JR"));
    assert.doesNotMatch(reply, /#3/);
  });

  it("shows one receipt", async (t) => {
    useClock(t);
    await app.chat(TAKE);
    const groupId = await onlyGroupId();
    const reply = (await app.chat("@receipts 1")).reply;
    assert.equal(
      reply,
      receiptDetailMessage(
        {
          number: 1,
          type: "take",
          status: "pending",
          capture: "manual",
          subjectName: "JR",
          statement: "The Giants win the division",
          madeOn: "2026-09-25",
          deadline: "2027-10-01",
          dateAmbiguous: false,
          heat: null
        },
        `${APP_URL}/g/${groupId}/r/1`
      )
    );
    assert.match((await app.chat("@receipts 9")).reply ?? "", /No receipt #9/);
  });

  it("lets the creator cancel within 24 hours", async (t) => {
    const clock = useClock(t);
    await app.chat(TAKE);
    assert.match((await app.chat("@receipts cancel 1", { senderHandle: CONNOR_HANDLE })).reply ?? "", /Only whoever logged #1/);
    assert.equal((await app.chat("@receipts cancel 1")).reply, canceledMessage(1));
    const [receipt] = await app.rows("receipts");
    assert.equal(receipt.status, "canceled");
    assert.match((await app.chat("@receipts cancel 1")).reply ?? "", /already canceled/);
    assert.match((await app.chat("@receipts 1")).reply ?? "", /was canceled/);
    assert.match((await app.chat("@receipts list")).reply ?? "", /Nothing pending/);

    await app.chat("@receipts Connor says OpenAI IPOs before 2028");
    clock.now += DAY + 1;
    assert.match((await app.chat("@receipts cancel 2")).reply ?? "", /permanent after 24 hours/);
  });

  it("asks unlinked senders to join before showing their receipts", async (t) => {
    useClock(t);
    assert.match((await app.chat("@receipts mine")).reply ?? "", /@receipts join/);
  });

  it("creates a 15-minute identity link", async (t) => {
    useClock(t);
    const result = await app.chat("@receipts join");
    const token = tokenFrom(result.reply);
    assert.ok(token.length >= 12);
    assert.match(result.reply ?? "", new RegExp(`${APP_URL}/join/${token}`));
    const [invite] = await app.rows("invites");
    const [identity] = await app.rows("identities");
    assert.equal(invite.kind, "join");
    assert.equal(invite.identityId, identity.id);
    assert.equal(invite.expiresAt, NOON + 15 * 60 * 1000);
  });

  it("creates a 7-day group invite", async (t) => {
    useClock(t);
    const result = await app.chat("@receipts setup");
    const token = tokenFrom(result.reply);
    assert.equal(result.reply, setupMessage("The Boys", `${APP_URL}/join/${token}`, 7));
    const [invite] = await app.rows("invites");
    assert.equal(invite.kind, "invite");
    assert.equal(invite.expiresAt, NOON + 7 * DAY);
  });

  it("stays quiet on stale informational commands", async (t) => {
    useClock(t);
    await app.chat(TAKE);
    for (const text of ["@receipts list", "@receipts upcoming", "@receipts help", "@receipts 1", "@receipts mine"]) {
      const result = await app.chat(text, { sentAt: NOON - 7 * HOUR });
      assert.equal(result.status, "processed");
      assert.equal(result.reply, null, text);
    }
  });
});

describe("deadline reminders", () => {
  async function due(): Promise<DueResponse> {
    const response = await app.bot("GET", "/api/bot/due");
    assert.equal(response.status, 200);
    return response.body as DueResponse;
  }

  it("lists receipts once their deadline passes until reminded", async (t) => {
    const clock = useClock(t);
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2026");
    await app.chat("@receipts JR said pineapple pizza is elite");
    assert.deepEqual(await due(), { reminders: [] });

    clock.now = dueAtFor("2026-10-01", -420) - 1;
    assert.deepEqual(await due(), { reminders: [] });

    clock.now = dueAtFor("2026-10-01", -420) + 5 * DAY;
    const { reminders } = await due();
    assert.equal(reminders.length, 1);
    const [receipt] = await app.rows("receipts");
    const groupId = await onlyGroupId();
    assert.equal(reminders[0].receiptId, receipt.id);
    assert.equal(reminders[0].chatGuid, CHAT);
    assert.match(reminders[0].message, /^🚨 RECEIPT DUE/);
    assert.match(reminders[0].message, /On Sep 25, 2026, JR said:/);
    assert.match(reminders[0].message, new RegExp(`${APP_URL}/g/${groupId}/r/1$`));

    assert.deepEqual(await app.bot("POST", "/api/bot/reminded", { receiptId: receipt.id }), { status: 200, body: { ok: true } });
    assert.deepEqual(await due(), { reminders: [] });
    assert.deepEqual(await app.bot("POST", "/api/bot/reminded", { receiptId: receipt.id }), { status: 200, body: { ok: true } });
    const [after] = await app.rows("receipts");
    assert.equal(after.remindedAt, clock.now);
  });

  it("never reminds about canceled receipts", async (t) => {
    const clock = useClock(t);
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2026");
    await app.chat("@receipts cancel 1");
    clock.now = dueAtFor("2026-10-01", -420) + DAY;
    assert.deepEqual(await due(), { reminders: [] });
  });

  it("caps each poll", async (t) => {
    const clock = useClock(t);
    for (let index = 0; index < 25; index += 1) {
      await app.chat(`@receipts #take JR says take ${index} lands by Oct 1 2026`);
    }
    clock.now = dueAtFor("2026-10-01", -420) + DAY;
    assert.equal((await due()).reminders.length, 20);
  });

  it("validates reminder acknowledgements", async () => {
    assert.equal((await app.bot("POST", "/api/bot/reminded", { receiptId: "missing" })).status, 404);
    assert.equal((await app.bot("POST", "/api/bot/reminded", { nope: true })).status, 400);
  });
});

describe("receipt list copy", () => {
  it("matches the shared formatter", async (t) => {
    useClock(t);
    await app.chat(TAKE);
    const groupId = await onlyGroupId();
    const reply = (await app.chat("@receipts list")).reply;
    assert.equal(
      reply,
      receiptListMessage(
        "PENDING",
        [
          {
            number: 1,
            type: "take",
            status: "pending",
            capture: "manual",
            subjectName: "JR",
            statement: "The Giants win the division",
            madeOn: "2026-09-25",
            deadline: "2027-10-01",
            dateAmbiguous: false,
            heat: null
          }
        ],
        `${APP_URL}/g/${groupId}`,
        "Nothing pending. Log one with @receipts #take."
      )
    );
  });
});

describe("names and aliases", () => {
  it("files receipts about a name under the sender who goes by it", async (t) => {
    useClock(t);
    await app.chat("@receipts call me Connor", { senderHandle: CONNOR_HANDLE });
    await app.chat("@receipts JR says Connor is washed");
    await app.chat("@receipts Connor says OpenAI IPOs before 2028");
    const connor = (await app.rows("identities")).find((row) => row.handle === CONNOR_HANDLE);
    const about = (await app.rows("receipts")).find((row) => row.number === 2);
    assert.equal(about?.subjectIdentityId, connor?.id);
    assert.equal(about?.subjectName, "Connor");
  });

  it("links earlier receipts about a name when someone takes it", async (t) => {
    useClock(t);
    await app.chat("@receipts Connor says OpenAI IPOs before 2028");
    await app.chat("@receipts connor: the Kings make the playoffs by April 20 2027");
    await app.chat("@receipts call me Connor", { senderHandle: CONNOR_HANDLE });
    const connor = (await app.rows("identities")).find((row) => row.handle === CONNOR_HANDLE);
    for (const receipt of await app.rows("receipts")) {
      assert.equal(receipt.subjectIdentityId, connor?.id);
    }
  });

  it("does not let two senders share a name", async (t) => {
    useClock(t);
    await app.chat("@receipts call me Connor", { senderHandle: CONNOR_HANDLE });
    const taken = await app.chat("@receipts call me connor", { senderHandle: JR_HANDLE });
    assert.match(taken.reply ?? "", /already goes by/);
    const jr = (await app.rows("identities")).find((row) => row.handle === JR_HANDLE);
    assert.equal(jr?.displayAlias, undefined);
    assert.match((await app.chat("@receipts call me Connor", { senderHandle: CONNOR_HANDLE })).reply ?? "", /Connor/);
  });

  it("respects names claimed in the record book when choosing a chat alias", async (t) => {
    useClock(t);
    await app.chat("@receipts Connor says OpenAI IPOs before 2028");
    const connorAccount = account("user-connor", "Connor");
    await app.mutation("redeemInvite", connorAccount, tokenFrom((await app.chat("@receipts setup")).reply));
    await app.mutation("claimName", connorAccount, await onlyGroupId(), "n:connor");

    const taken = await app.chat("@receipts call me Connor", { senderHandle: JR_HANDLE });
    assert.match(taken.reply ?? "", /already claimed Connor/);
    assert.equal((await app.rows("identities")).find((row) => row.handle === JR_HANDLE)?.displayAlias, undefined);
    await app.chat("@receipts Connor says the Giants win tomorrow");
    assert.equal((await app.rows("receipts"))[1].subjectUserId, "user-connor");

    await app.mutation("redeemInvite", connorAccount, tokenFrom((await app.chat("@receipts join", { senderHandle: CONNOR_HANDLE })).reply));
    const ownName = await app.chat("@receipts call me Connor", { senderHandle: CONNOR_HANDLE });
    assert.match(ownName.reply ?? "", /Connor/);
    assert.equal((await app.rows("identities")).find((row) => row.handle === CONNOR_HANDLE)?.displayAlias, "Connor");
  });
});

describe("settling in chat", () => {
  const SARAH_HANDLE = "+15555550555";
  const ALEX_HANDLE = "+15555550777";

  /** JR goes by "JR"; Connor logs a take about JR. */
  async function jrTake(text = TAKE) {
    await app.chat("@receipts call me JR", { senderHandle: JR_HANDLE });
    await app.chat(text, { senderHandle: CONNOR_HANDLE });
  }

  async function identityId(handle: string) {
    return (await app.rows("identities")).find((row) => row.handle === handle)?.id;
  }

  it("settles at any time, before the deadline too", async (t) => {
    useClock(t);
    await jrTake();
    const result = await app.chat("@receipts 1 right", { senderHandle: SARAH_HANDLE });
    const [receipt] = await app.rows("receipts");
    assert.equal(receipt.status, "right");
    assert.equal(receipt.settledAt, NOON);
    const [settlement] = await app.rows("settlements");
    assert.equal(settlement.outcome, "right");
    assert.equal(settlement.settledByIdentityId, await identityId(SARAH_HANDLE));
    assert.equal(settlement.settledByUserId, undefined);
    assert.equal(
      result.reply,
      settledMessage(
        {
          number: 1,
          type: "take",
          status: "right",
          capture: "manual",
          subjectName: "JR",
          statement: "The Giants win the division",
          madeOn: "2026-09-25",
          deadline: "2027-10-01",
          dateAmbiguous: false,
          heat: null
        },
        { outcome: "right", settlerName: maskHandle(SARAH_HANDLE), points: 1 }
      )
    );
  });

  it("does not let the take's author settle it", async (t) => {
    useClock(t);
    await jrTake();
    assert.match((await app.chat("@receipts 1 right", { senderHandle: JR_HANDLE })).reply ?? "", /can't settle your own/);
    assert.equal((await app.rows("receipts"))[0].status, "pending");
    assert.equal((await app.rows("settlements")).length, 0);
  });

  it("does not let the nominator settle it", async (t) => {
    useClock(t);
    await app.reply("@receipts #take by Apr 15 2027", { text: "Warriors top 4, easy", authorHandle: JR_HANDLE }, { senderHandle: ALEX_HANDLE });
    await app.chat("@receipts accept 1", { senderHandle: JR_HANDLE });
    assert.match((await app.chat("@receipts 1 wrong", { senderHandle: ALEX_HANDLE })).reply ?? "", /nominated/);
    assert.equal((await app.rows("receipts"))[0].status, "pending");
    await app.chat("@receipts 1 wrong", { senderHandle: SARAH_HANDLE });
    assert.equal((await app.rows("receipts"))[0].status, "wrong");
  });

  it("lets whoever logged a claim about someone else settle it", async (t) => {
    useClock(t);
    await jrTake();
    await app.chat("@receipts 1 wrong", { senderHandle: CONNOR_HANDLE });
    assert.equal((await app.rows("receipts"))[0].status, "wrong");
  });

  it("explains receipts that cannot be settled from chat", async (t) => {
    useClock(t);
    await jrTake();
    await app.chat("@receipts 1 right", { senderHandle: SARAH_HANDLE });
    assert.match((await app.chat("@receipts 1 wrong", { senderHandle: SARAH_HANDLE })).reply ?? "", /already settled/);
    assert.equal((await app.rows("receipts"))[0].status, "right");
    assert.equal((await app.rows("settlements")).length, 1);

    await app.reply("@receipts #take by Apr 15 2027", { text: "Warriors top 4, easy", authorHandle: JR_HANDLE }, { senderHandle: ALEX_HANDLE });
    assert.match((await app.chat("@receipts 2 right", { senderHandle: SARAH_HANDLE })).reply ?? "", /once JR has accepted/);
    await app.chat("@receipts reject 2", { senderHandle: JR_HANDLE });
    assert.match((await app.chat("@receipts 2 right", { senderHandle: SARAH_HANDLE })).reply ?? "", /declined/);

    await app.chat("@receipts Connor says OpenAI IPOs before 2028", { senderHandle: SARAH_HANDLE });
    await app.chat("@receipts cancel 3", { senderHandle: SARAH_HANDLE });
    assert.match((await app.chat("@receipts 3 right", { senderHandle: CONNOR_HANDLE })).reply ?? "", /canceled/);
    assert.match((await app.chat("@receipts 9 right", { senderHandle: CONNOR_HANDLE })).reply ?? "", /No receipt #9/);
  });

  it("settles messages sent while the Mac was asleep", async (t) => {
    useClock(t);
    await jrTake();
    const late = await app.chat("@receipts 1 void", { senderHandle: SARAH_HANDLE, sentAt: NOON - 10 * HOUR });
    assert.equal((await app.rows("receipts"))[0].status, "void");
    assert.notEqual(late.reply, null);
  });

  it("credits chat settlements to the settler's account once they link it", async (t) => {
    useClock(t);
    await jrTake();
    await app.chat("@receipts 1 right", { senderHandle: SARAH_HANDLE });
    await app.mutation("redeemInvite", account("user-sarah", "Sarah P"), tokenFrom((await app.chat("@receipts join", { senderHandle: SARAH_HANDLE })).reply));
    const [settlement] = await app.rows("settlements");
    assert.equal(settlement.settledByUserId, "user-sarah");
  });
});
