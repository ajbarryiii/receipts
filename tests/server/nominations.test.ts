import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import type { DueResponse } from "../../app/shared/bot-api";
import { dueAtFor } from "../../app/shared/dates";
import { acceptedMessage, confirmationMessage, maskHandle, nominationMessage, rejectedMessage } from "../../app/shared/format";
import { account, APP_URL, CONNOR_HANDLE, JR_HANDLE, TestApp, tokenFrom } from "./harness";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Noon PDT on Friday, Sep 25 2026.
const NOON = Date.UTC(2026, 8, 25, 19, 0);
const ALEX_HANDLE = "+15555550777";
const JR_EMAIL = "jr@icloud.com";

const QUOTE = "There is no chance the Warriors finish below the 4 seed.";
const SAID_AT = NOON - HOUR;

const JR = account("user-jr", "JR Smith");
const ALEX = account("user-alex", "Alex R");
const CONNOR = account("user-connor", "Connor K");

function useClock(t: TestContext, start = NOON) {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

let app: TestApp;

beforeEach(() => {
  app = new TestApp();
});

async function nameEveryone() {
  await app.chat("@receipts call me JR", { senderHandle: JR_HANDLE });
  await app.chat("@receipts call me Alex", { senderHandle: ALEX_HANDLE });
}

/** Alex replies "@receipts ..." to JR's message. */
function nominate(command = "@receipts #take by Apr 15 2027", source: Partial<{ text: string; sentAt: number }> = {}) {
  return app.reply(command, { text: QUOTE, authorHandle: JR_HANDLE, sentAt: SAID_AT, ...source }, { senderHandle: ALEX_HANDLE });
}

async function receipt(number = 1) {
  const row = (await app.rows("receipts")).find((candidate) => candidate.number === number);
  assert.ok(row, `receipt #${number}`);
  return row;
}

async function identityId(handle: string): Promise<string> {
  const row = (await app.rows("identities")).find((identity) => identity.handle === handle.toLowerCase());
  assert.ok(row, handle);
  return row.id as string;
}

async function groupId(): Promise<string> {
  const [group] = await app.rows("groups");
  return group.id as string;
}

describe("reply-based capture", () => {
  it("nominates someone else's message and keeps the exact quote", async (t) => {
    useClock(t);
    await nameEveryone();
    const result = await nominate();
    assert.equal(result.status, "processed");
    assert.equal(
      result.reply,
      nominationMessage(
        {
          number: 1,
          type: "take",
          status: "nominated",
          capture: "reply",
          subjectName: "JR",
          statement: QUOTE,
          madeOn: "2026-09-25",
          deadline: "2027-04-15",
          dateAmbiguous: false,
          heat: null
        },
        { nominatorName: "Alex", today: "2026-09-25", late: false }
      )
    );

    const row = await receipt();
    assert.equal(row.status, "nominated");
    assert.equal(row.capture, "reply");
    assert.equal(row.statement, QUOTE);
    assert.equal(row.originalText, "@receipts #take by Apr 15 2027");
    assert.equal(row.commandMessageGuid, result.messageGuid);
    assert.equal(row.sourceMessageGuid, "source-1");
    assert.equal(row.sourceSentAt, SAID_AT);
    assert.equal(row.madeAt, SAID_AT);
    assert.equal(row.subjectIdentityId, await identityId(JR_HANDLE));
    assert.equal(row.createdByIdentityId, await identityId(ALEX_HANDLE));
    assert.equal(row.nominatedAt, NOON);
    assert.equal(row.deadline, "2027-04-15");
  });

  it("records a reply to your own message immediately", async (t) => {
    useClock(t);
    await nameEveryone();
    const result = await app.reply("@receipts #take by Apr 15 2027", { text: QUOTE, authorHandle: JR_HANDLE, sentAt: SAID_AT }, { senderHandle: JR_HANDLE });
    assert.equal(
      result.reply,
      confirmationMessage(
        {
          number: 1,
          type: "take",
          status: "pending",
          capture: "reply",
          subjectName: "JR",
          statement: QUOTE,
          madeOn: "2026-09-25",
          deadline: "2027-04-15",
          dateAmbiguous: false,
          heat: null
        },
        { today: "2026-09-25", late: false }
      )
    );
    const row = await receipt();
    assert.equal(row.status, "pending");
    assert.equal(row.capture, "reply");
    assert.equal(row.nominatedAt, undefined);
  });

  it("uses a date in the quoted message when the command has none", async (t) => {
    useClock(t);
    await nominate("@receipts", { text: "OpenAI IPOs before 2028" });
    const row = await receipt();
    assert.equal(row.type, "take");
    assert.equal(row.deadline, "2028-01-01");
    assert.equal(row.statement, "OpenAI IPOs before 2028");
  });

  it("asks for a deadline instead of inventing one", async (t) => {
    useClock(t);
    const result = await nominate("@receipts #take", { text: "The Warriors are frauds" });
    assert.match(result.reply ?? "", /By when/);
    assert.equal((await app.rows("receipts")).length, 0);

    await nominate("@receipts #generic", { text: "The Warriors are frauds" });
    assert.equal((await receipt()).deadline, undefined);
  });

  it("processes each command once and each source message once", async (t) => {
    useClock(t);
    const first = await nominate();
    await app.reply("@receipts #take by Apr 15 2027", { messageGuid: "source-1", text: QUOTE, authorHandle: JR_HANDLE }, {
      messageGuid: first.messageGuid,
      senderHandle: ALEX_HANDLE
    });
    assert.equal((await app.rows("receipts")).length, 1);

    const again = await app.reply("@receipts #take by May 1 2027", { messageGuid: "source-1", text: QUOTE, authorHandle: JR_HANDLE }, {
      senderHandle: CONNOR_HANDLE
    });
    assert.match(again.reply ?? "", /already Receipt #1/);
    assert.equal((await app.rows("receipts")).length, 1);
  });

  it("treats a full manual receipt sent as a reply as manual", async (t) => {
    useClock(t);
    await app.reply("@receipts #take Connor says OpenAI IPOs before 2028", { text: QUOTE, authorHandle: JR_HANDLE }, { senderHandle: ALEX_HANDLE });
    const row = await receipt();
    assert.equal(row.capture, "manual");
    assert.equal(row.subjectName, "Connor");
    assert.equal(row.status, "pending");
  });

  it("names people after 'call me', including earlier receipts about them", async (t) => {
    useClock(t);
    await nominate();
    assert.equal((await receipt()).subjectName, maskHandle(JR_HANDLE));
    await app.chat("@receipts call me JR", { senderHandle: JR_HANDLE });
    assert.equal((await receipt()).subjectName, "JR");
  });
});

describe("accepting and rejecting in chat", () => {
  it("lets only the author accept, once", async (t) => {
    const clock = useClock(t);
    await nameEveryone();
    await nominate();

    const intruder = await app.chat("@receipts accept 1", { senderHandle: CONNOR_HANDLE });
    assert.match(intruder.reply ?? "", /Only JR can accept #1/);
    assert.equal((await receipt()).status, "nominated");

    clock.now += HOUR;
    const accepted = await app.chat("@receipts accept 1", { senderHandle: JR_HANDLE });
    const row = await receipt();
    assert.equal(row.status, "pending");
    assert.equal(row.acceptedAt, clock.now);
    assert.equal(
      accepted.reply,
      acceptedMessage(
        {
          number: 1,
          type: "take",
          status: "pending",
          capture: "reply",
          subjectName: "JR",
          statement: QUOTE,
          madeOn: "2026-09-25",
          deadline: "2027-04-15",
          dateAmbiguous: false,
          heat: null
        },
        `${APP_URL}/g/${await groupId()}/r/1`
      )
    );

    clock.now += HOUR;
    const again = await app.chat("@receipts accept 1", { senderHandle: JR_HANDLE });
    assert.match(again.reply ?? "", /already on the record/);
    assert.equal((await receipt()).acceptedAt, clock.now - HOUR);
    assert.match((await app.chat("@receipts reject 1", { senderHandle: JR_HANDLE })).reply ?? "", /already on the record/);
    assert.equal((await receipt()).status, "pending");
  });

  it("lets the author reject, and keeps rejection final and idempotent", async (t) => {
    useClock(t);
    await nameEveryone();
    await nominate();
    assert.match((await app.chat("@receipts reject 1", { senderHandle: ALEX_HANDLE })).reply ?? "", /Only JR can reject #1/);

    const rejected = await app.chat("@receipts reject 1", { senderHandle: JR_HANDLE });
    assert.equal(rejected.reply, rejectedMessage({ number: 1, subjectName: "JR" }));
    const row = await receipt();
    assert.equal(row.status, "rejected");
    assert.equal(row.rejectedAt, NOON);

    assert.match((await app.chat("@receipts reject 1", { senderHandle: JR_HANDLE })).reply ?? "", /already declined/);
    assert.match((await app.chat("@receipts accept 1", { senderHandle: JR_HANDLE })).reply ?? "", /already declined/);
    assert.equal((await receipt()).status, "rejected");
  });

  it("explains accept on receipts that were never nominated", async (t) => {
    useClock(t);
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2027");
    assert.match((await app.chat("@receipts accept 1")).reply ?? "", /isn't a nomination/);
    assert.match((await app.chat("@receipts accept 9")).reply ?? "", /No receipt #9/);
  });

  it("processes accepts sent while the Mac was asleep", async (t) => {
    useClock(t);
    await nominate();
    const late = await app.chat("@receipts accept 1", { senderHandle: JR_HANDLE, sentAt: NOON - 10 * HOUR });
    assert.equal((await receipt()).status, "pending");
    assert.notEqual(late.reply, null);
  });

  it("accepts from another handle linked to the author's account", async (t) => {
    useClock(t);
    await app.mutation("redeemInvite", JR, tokenFrom((await app.chat("@receipts join", { senderHandle: JR_HANDLE })).reply));
    await app.mutation("redeemInvite", JR, tokenFrom((await app.chat("@receipts join", { senderHandle: JR_EMAIL })).reply));
    await nominate();
    await app.chat("@receipts accept 1", { senderHandle: JR_EMAIL });
    assert.equal((await receipt()).status, "pending");
  });

  it("lets the nominator withdraw within 24 hours", async (t) => {
    useClock(t);
    await nominate();
    assert.match((await app.chat("@receipts cancel 1", { senderHandle: JR_HANDLE })).reply ?? "", /Only whoever logged #1/);
    await app.chat("@receipts cancel 1", { senderHandle: ALEX_HANDLE });
    assert.equal((await receipt()).status, "canceled");
  });
});

describe("nominations stay off the record until accepted", () => {
  async function due(): Promise<DueResponse> {
    return (await app.bot("GET", "/api/bot/due")).body as DueResponse;
  }

  it("skips reminders and lists, but shows nominations on request", async (t) => {
    const clock = useClock(t);
    await nameEveryone();
    await nominate("@receipts #take by Oct 1 2026");
    clock.now = dueAtFor("2026-10-01", -420) + DAY;

    assert.deepEqual(await due(), { reminders: [] });
    assert.match((await app.chat("@receipts list")).reply ?? "", /Nothing pending/);
    assert.match((await app.chat("@receipts upcoming")).reply ?? "", /Nothing with a due date/);
    const nominations = (await app.chat("@receipts nominations")).reply ?? "";
    assert.match(nominations, /NOMINATIONS/);
    assert.match(nominations, /#1 JR/);

    await app.chat("@receipts accept 1", { senderHandle: JR_HANDLE });
    assert.equal((await due()).reminders.length, 1);
    assert.match((await app.chat("@receipts nominations")).reply ?? "", /No open nominations/);
  });
});

describe("nominations on the web", () => {
  /** JR links their handle; Alex and Connor join through the group invite. */
  async function setUp(): Promise<string> {
    await app.mutation("redeemInvite", JR, tokenFrom((await app.chat("@receipts join", { senderHandle: JR_HANDLE })).reply));
    await app.mutation("redeemInvite", ALEX, tokenFrom((await app.chat("@receipts join", { senderHandle: ALEX_HANDLE })).reply));
    const invite = tokenFrom((await app.chat("@receipts setup")).reply);
    await app.mutation("redeemInvite", CONNOR, invite);
    return groupId();
  }

  it("lists nominations separately from the official record", async (t) => {
    useClock(t);
    const id = await setUp();
    await nominate();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028", { senderHandle: CONNOR_HANDLE });

    const group = await app.query("group", CONNOR, id);
    assert.ok(group);
    assert.deepEqual(group.nominations.map((card) => card.number), [1]);
    assert.deepEqual(group.pending.map((card) => card.number), [2]);
    assert.deepEqual(group.standings.map((standing) => standing.subjectRef), ["n:connor"]);
    const [card] = group.nominations;
    assert.equal(card.capture, "reply");
    assert.equal(card.statement, QUOTE);
    assert.equal(card.subjectName, "JR Smith");
    assert.deepEqual(card.nomination, { state: "pending", nominatedByName: "Alex R", nominatedAt: NOON });

    const profile = await app.query("profile", CONNOR, id, "u:user-jr");
    assert.deepEqual(profile?.nominations.map((nomination) => nomination.number), [1]);
    assert.deepEqual(profile?.currentTakes, []);
  });

  it("blocks heat and settlement until accepted", async (t) => {
    useClock(t);
    const id = await setUp();
    await nominate();
    const receiptId = (await receipt()).id as string;
    await assert.rejects(app.mutation("voteHeat", CONNOR, receiptId, 4), /opens once JR Smith accepts/);
    await assert.rejects(app.mutation("settleReceipt", CONNOR, receiptId, "right", null), /accepted/);
    await assert.rejects(app.mutation("setDeadline", CONNOR, receiptId, "2027-05-01"), /pending/);
    assert.match((await app.query("receipt", CONNOR, id, 1))?.voteBlockedReason ?? "", /opens once/);

    await app.mutation("respondToNomination", JR, receiptId, true);
    assert.deepEqual(await app.mutation("voteHeat", CONNOR, receiptId, 4), { heat: 4 });
  });

  it("lets only the linked author respond, idempotently", async (t) => {
    useClock(t);
    const id = await setUp();
    await nominate();
    const receiptId = (await receipt()).id as string;

    assert.equal((await app.query("receipt", JR, id, 1))?.canRespond, true);
    assert.equal((await app.query("receipt", ALEX, id, 1))?.canRespond, false);
    await assert.rejects(app.mutation("respondToNomination", ALEX, receiptId, true), /Only JR Smith/);
    await assert.rejects(app.mutation("respondToNomination", account("user-x"), receiptId, true), /not a member/);

    await app.mutation("respondToNomination", JR, receiptId, true);
    await app.mutation("respondToNomination", JR, receiptId, true);
    await assert.rejects(app.mutation("respondToNomination", JR, receiptId, false), /already accepted/);

    const detail = await app.query("receipt", CONNOR, id, 1);
    assert.equal(detail?.card.status, "pending");
    assert.deepEqual(detail?.card.nomination, { state: "accepted", nominatedByName: "Alex R", nominatedAt: NOON });
    assert.equal(detail?.canRespond, false);
    assert.equal(detail?.card.capture, "reply");
  });

  it("does not let the nominator settle, and explains why", async (t) => {
    useClock(t);
    const id = await setUp();
    await nominate();
    const receiptId = (await receipt()).id as string;
    assert.match((await app.query("receipt", CONNOR, id, 1))?.settleBlockedReason ?? "", /once JR Smith has accepted/);

    await app.mutation("respondToNomination", JR, receiptId, true);
    await assert.rejects(app.mutation("settleReceipt", ALEX, receiptId, "wrong", null), /nominated/);
    const alex = await app.query("receipt", ALEX, id, 1);
    assert.equal(alex?.canSettle, false);
    assert.match(alex?.settleBlockedReason ?? "", /nominated/);
    await app.mutation("settleReceipt", CONNOR, receiptId, "wrong", null);
    assert.equal((await receipt()).status, "wrong");
  });

  it("keeps rejected nominations out of every list and score", async (t) => {
    useClock(t);
    const id = await setUp();
    await nominate();
    const receiptId = (await receipt()).id as string;
    await app.mutation("respondToNomination", JR, receiptId, false);
    await app.mutation("respondToNomination", JR, receiptId, false);
    await assert.rejects(app.mutation("respondToNomination", JR, receiptId, true), /already declined/);

    const group = await app.query("group", CONNOR, id);
    assert.deepEqual(group?.nominations, []);
    assert.deepEqual(group?.pending, []);
    assert.deepEqual(group?.standings, []);
    const detail = await app.query("receipt", CONNOR, id, 1);
    assert.equal(detail?.card.status, "rejected");
    assert.equal(detail?.card.nomination?.state, "rejected");
  });
});

describe("reply guardrails", () => {
  it("asks for the take to be spelled out when the reply thread is ambiguous", async (t) => {
    useClock(t);
    const result = await app.reply("@receipts #take by Apr 15 2027", { text: QUOTE, authorHandle: JR_HANDLE, ambiguous: true }, { senderHandle: ALEX_HANDLE });
    assert.match(result.reply ?? "", /can't tell which message/);
    assert.match(result.reply ?? "", /@receipts #take <name>: <the take> by Apr 15 2027/);
    assert.equal((await app.rows("receipts")).length, 0);

    // Spelling it out works, as a recorded claim rather than an original.
    await app.reply("@receipts #take JR: the Warriors finish top 4 by Apr 15 2027", { text: QUOTE, authorHandle: JR_HANDLE, ambiguous: true }, {
      senderHandle: ALEX_HANDLE
    });
    const row = await receipt();
    assert.equal(row.capture, "manual");
    assert.equal(row.statement, "The Warriors finish top 4");
    assert.equal(row.sourceMessageGuid, undefined);
  });

  it("still runs commands sent inside ambiguous threads", async (t) => {
    useClock(t);
    await nominate();
    await app.reply("@receipts accept 1", { text: QUOTE, authorHandle: JR_HANDLE, ambiguous: true }, { senderHandle: JR_HANDLE });
    assert.equal((await receipt()).status, "pending");
  });

  it("points a second nomination of the same message at the first", async (t) => {
    useClock(t);
    await nameEveryone();
    await nominate();
    const again = await app.reply("@receipts #bet by May 1 2027", { messageGuid: "source-1", text: QUOTE, authorHandle: JR_HANDLE }, {
      senderHandle: CONNOR_HANDLE
    });
    assert.match(again.reply ?? "", /already Receipt #1, waiting on JR to accept/);
    assert.equal((await app.rows("receipts")).length, 1);

    const author = await app.reply("@receipts #take", { messageGuid: "source-1", text: QUOTE, authorHandle: JR_HANDLE }, { senderHandle: JR_HANDLE });
    assert.match(author.reply ?? "", /reply "@receipts accept 1"/);
    assert.equal((await receipt()).status, "nominated");

    await app.chat("@receipts reject 1", { senderHandle: JR_HANDLE });
    const afterReject = await app.reply("@receipts #take by Apr 15 2027", { messageGuid: "source-1", text: QUOTE, authorHandle: JR_HANDLE }, {
      senderHandle: CONNOR_HANDLE
    });
    assert.match(afterReject.reply ?? "", /JR already declined that one \(#1\)/);
    assert.equal((await app.rows("receipts")).length, 1);
  });

  it("lets a message be captured again after its receipt was withdrawn", async (t) => {
    useClock(t);
    await nominate();
    await app.chat("@receipts cancel 1", { senderHandle: ALEX_HANDLE });
    await app.reply("@receipts #take by Apr 15 2027", { messageGuid: "source-1", text: QUOTE, authorHandle: JR_HANDLE }, { senderHandle: CONNOR_HANDLE });
    assert.equal((await receipt(2)).status, "nominated");
  });

  it("does not log the same open take twice", async (t) => {
    useClock(t);
    await app.chat("@receipts #take JR says the Giants win the division by Oct 1 2027", { senderHandle: ALEX_HANDLE });
    const again = await app.chat("@receipts jr says the giants win the division by Oct 1 2027!", { senderHandle: CONNOR_HANDLE });
    assert.match(again.reply ?? "", /already Receipt #1/);
    assert.equal((await app.rows("receipts")).length, 1);

    // A different deadline is a different take.
    await app.chat("@receipts #take JR says the Giants win the division by Oct 1 2028", { senderHandle: CONNOR_HANDLE });
    assert.equal((await app.rows("receipts")).length, 2);
  });

  it("allows the same claim again once the earlier one is settled", async (t) => {
    useClock(t);
    await app.chat("@receipts #take JR says the Giants win the division by Oct 1 2027", { senderHandle: ALEX_HANDLE });
    await app.chat("@receipts 1 wrong", { senderHandle: CONNOR_HANDLE });
    await app.chat("@receipts #take JR says the Giants win the division by Oct 1 2027", { senderHandle: ALEX_HANDLE });
    assert.equal((await app.rows("receipts")).length, 2);
  });
});
