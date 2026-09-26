import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import type { AnnouncementsResponse, DueAnnouncement, DueResponse } from "../../app/shared/bot-api";
import { dueAtFor } from "../../app/shared/dates";
import {
  anointedMessage,
  blitzOverMessage,
  blitzStartMessage,
  blitzStatusMessage,
  blitzTakeMessage,
  lastCallMessage
} from "../../app/shared/format";
import type { BlitzStanding } from "../../app/shared/types";
import { account, APP_URL, CHAT, TestApp, tokenFrom } from "./harness";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OFFSET = -420;
// 8:14pm PDT on Friday, Sep 25 2026.
const START = Date.UTC(2026, 8, 26, 3, 14);
const ENDS = START + DAY;
const LAST_CALL = START + 6 * DAY;
const ANOINT = START + 7 * DAY;
const times = { endsAt: ENDS, anointAt: ANOINT, utcOffsetMinutes: OFFSET };

const SAM = "+15555550111";
const DANA = "+15555550222";
const ALEX = "+15555550333";
const PEOPLE: [string, string][] = [
  [SAM, "Sam"],
  [DANA, "Dana"],
  [ALEX, "Alex"]
];

type Clock = { now: number };

function useClock(t: TestContext, start = START - HOUR): Clock {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

let app: TestApp;

beforeEach(() => {
  app = new TestApp();
});

/** Sends a chat message from `handle`, a second before the clock. */
async function say(handle: string, text: string): Promise<string | null> {
  return (await app.chat(text, { senderHandle: handle })).reply;
}

async function reply(handle: string, text: string): Promise<string> {
  const answer = await say(handle, text);
  assert.ok(answer, `no reply to ${text}`);
  return answer;
}

/** Everyone picks a name; with `accounts`, everyone also links a web account. */
async function meetTheGroup(accounts = false): Promise<void> {
  for (const [handle, name] of PEOPLE) {
    await say(handle, `@receipts call me ${name}`);
    if (accounts) {
      const token = tokenFrom(await say(handle, "@receipts join"));
      await app.mutation("redeemInvite", account(`user-${name.toLowerCase()}`, name), token);
    }
  }
}

/** Sam sends "@receipts lfg" at START; the clock then moves a minute into the blitz. */
async function startBlitz(clock: Clock): Promise<string> {
  clock.now = START;
  const { reply: opener } = await app.chat("@receipts lfg", { senderHandle: SAM, sentAt: START });
  assert.ok(opener);
  clock.now = START + MINUTE;
  return opener;
}

/** Sam banks two lightning takes (#1, #2: 8 points); Dana a lightning and a week take (#3, #4: 6 points). */
async function playBlitz(clock: Clock, accounts = false): Promise<void> {
  await meetTheGroup(accounts);
  await startBlitz(clock);
  await say(SAM, "@receipts the Giants win tonight");
  await say(SAM, "@receipts the Jets lose tomorrow");
  await say(DANA, "@receipts Sam is late to brunch tomorrow");
  await say(DANA, "@receipts it rains by Sep 30 2026");
}

async function groupRow(): Promise<Record<string, unknown>> {
  const [group] = await app.rows("groups");
  return group;
}

async function groupUrl(): Promise<string> {
  return `${APP_URL}/g/${(await groupRow()).id}`;
}

async function receipt(number: number): Promise<Record<string, unknown>> {
  const row = (await app.rows("receipts")).find((candidate) => candidate.number === number);
  assert.ok(row, `receipt #${number}`);
  return row;
}

async function ref(handle: string): Promise<string> {
  const identity = (await app.rows("identities")).find((row) => row.handle === handle);
  assert.ok(identity, `identity ${handle}`);
  return identity.userId ? `u:${identity.userId}` : `i:${identity.id}`;
}

function standing(subjectRef: string, name: string, takes: number, banked: number, tab: number): BlitzStanding {
  return { subjectRef, name, takes, banked, tab, total: banked + tab };
}

async function announcements(): Promise<DueAnnouncement[]> {
  const response = await app.bot("GET", "/api/bot/announcements");
  assert.equal(response.status, 200);
  return (response.body as AnnouncementsResponse).announcements;
}

async function announced(announcementId: string) {
  return app.bot("POST", "/api/bot/announced", { announcementId });
}

/** Fetches what's due, expects exactly one announcement, and acknowledges it. */
async function deliverOne(): Promise<string> {
  const due = await announcements();
  assert.equal(due.length, 1, JSON.stringify(due));
  assert.equal(due[0].chatGuid, CHAT);
  assert.deepEqual(await announced(due[0].announcementId), { status: 200, body: { ok: true } });
  return due[0].message;
}

describe("@receipts lfg", () => {
  it("starts the blitz with the rules and a record book invite", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    const opener = await startBlitz(clock);
    const token = tokenFrom(opener);
    assert.equal(opener, blitzStartMessage(times, { url: `${APP_URL}/join/${token}`, expiresInDays: 7 }));

    assert.equal((await groupRow()).blitzStartedAt, START);
    const invite = (await app.rows("invites")).find((row) => row.token === token);
    assert.equal(invite?.kind, "invite");
    const scheduled = (await app.rows("announcements")).sort((a, b) => (a.sendAt as number) - (b.sendAt as number));
    assert.deepEqual(
      scheduled.map((row) => [row.kind, row.sendAt, row.sentAt]),
      [
        ["blitz_over", ENDS, undefined],
        ["last_call", LAST_CALL, undefined],
        ["anointed", ANOINT, undefined]
      ]
    );
  });

  it("only ever starts one blitz per group", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = START + HOUR;
    assert.equal(await say(DANA, "@receipts lfg"), blitzStatusMessage("live", times, []));
    clock.now = ENDS + HOUR;
    assert.equal(await say(DANA, "@receipts lfg"), blitzStatusMessage("provisional", times, ["Sam"]));
    assert.equal((await groupRow()).blitzStartedAt, START);
    assert.equal((await app.rows("announcements")).length, 3);
  });

  it("keeps the original window when lfg and takes arrive after an outage", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    clock.now = ENDS + HOUR;
    await app.chat("@receipts lfg", { senderHandle: SAM, sentAt: START });
    assert.equal((await groupRow()).blitzStartedAt, START);

    await app.chat("@receipts the Giants win tonight", { senderHandle: SAM, sentAt: START + HOUR });
    assert.equal((await receipt(1)).blitzPoints, 4);
    await say(SAM, "@receipts the Jets win tomorrow");
    assert.equal((await receipt(2)).blitzPoints, undefined);
    assert.match(await say(SAM, "@receipts lfg") ?? "", /blitz is over/i);
  });
});

describe("blitz takes", () => {
  it("score the sender's takes by how soon they come due", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);

    const lightning = await reply(SAM, "@receipts the Giants win tonight");
    assert.equal(
      lightning,
      blitzTakeMessage(
        {
          number: 1,
          type: "take",
          status: "pending",
          capture: "manual",
          subjectName: "Sam",
          statement: "The Giants win",
          madeOn: "2026-09-25",
          deadline: "2026-09-25",
          dateAmbiguous: false,
          heat: null
        },
        { points: 4, total: 4, left: 9, blocked: null },
        { late: false }
      )
    );
    assert.equal((await receipt(1)).blitzPoints, 4);

    const week = await reply(SAM, "@receipts the Jets lose by Sep 30 2026");
    assert.equal(week.split("\n")[0], "🧾 #2 LOCKED · Sam +2");
    assert.match(week, /Sam's blitz total: 6 · 8 takes left/);
    assert.equal((await receipt(2)).blitzPoints, 2);

    const late = await reply(SAM, "@receipts the Mets win the World Series by Oct 31 2026");
    assert.match(late, /No blitz points: it's due after the 👑 is anointed/);
    assert.equal((await receipt(3)).blitzPoints, undefined);
    assert.equal((await receipt(3)).type, "take");
  });

  it("date undated takes the day before the anointing", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    await say(SAM, "@receipts Dana shows up late to brunch");
    const row = await receipt(1);
    assert.equal(row.type, "take");
    assert.equal(row.deadline, "2026-10-01");
    assert.equal(row.blitzPoints, 2);

    const note = await reply(SAM, "@receipts #note bring the grill");
    assert.match(note, /^🧾 RECEIPT LOCKED/);
    assert.equal((await receipt(2)).type, "generic");
    assert.equal((await receipt(2)).deadline, undefined);
    assert.equal((await receipt(2)).blitzPoints, undefined);
  });

  it("only score takes people make about themselves", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    const answer = await reply(SAM, "@receipts Dana says the Knicks win tomorrow");
    assert.match(answer, /^🧾 TAKE LOCKED/);
    const row = await receipt(1);
    assert.equal(row.subjectName, "Dana");
    assert.equal(row.blitzPoints, undefined);
  });

  it("scores self-reply takes and supplies the same default deadline as typed takes", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    const captured = await app.reply("@receipts #take by tomorrow", { text: "The Giants win", authorHandle: SAM }, { senderHandle: SAM });
    assert.equal((await receipt(1)).blitzPoints, 4);
    assert.match(captured.reply ?? "", /Sam \+4/);

    await app.reply("@receipts #take", { text: "The Jets win", authorHandle: SAM }, { senderHandle: SAM });
    assert.equal((await receipt(2)).blitzPoints, 2);
    assert.equal((await receipt(2)).deadline, "2026-10-01");

    await app.reply("@receipts", { text: "Dana shows up late to brunch", authorHandle: SAM }, { senderHandle: SAM });
    assert.equal((await receipt(3)).type, "take");
    assert.equal((await receipt(3)).blitzPoints, 2);

    await app.reply("@receipts #note", { text: "Bring the grill", authorHandle: SAM }, { senderHandle: SAM });
    assert.equal((await receipt(4)).type, "generic");
    assert.equal((await receipt(4)).blitzPoints, undefined);
    assert.equal((await receipt(4)).deadline, undefined);
  });

  it("shares the scoring cap between typed takes and self-reply takes", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    for (let n = 1; n <= 10; n += 1) {
      await say(SAM, `@receipts thing ${n} happens tomorrow`);
    }
    const captured = await app.reply("@receipts #take by tomorrow", { text: "The Giants win", authorHandle: SAM }, { senderHandle: SAM });
    assert.equal((await receipt(11)).blitzPoints, undefined);
    assert.match(captured.reply ?? "", /used all 10/);
  });

  it("keeps nominations outside the sender's blitz points", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    await app.reply("@receipts #take by tomorrow", { text: "The Giants win", authorHandle: DANA }, { senderHandle: SAM });
    assert.equal((await receipt(1)).status, "nominated");
    assert.equal((await receipt(1)).blitzPoints, undefined);
    const undated = await app.reply("@receipts #take", { text: "The Jets win", authorHandle: DANA }, { senderHandle: SAM });
    assert.match(undated.reply ?? "", /By when/);
    assert.equal((await app.rows("receipts")).length, 1);
  });

  it("stop scoring after 10 takes a person, not counting canceled ones", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    for (let n = 1; n <= 10; n += 1) {
      const answer = await reply(SAM, `@receipts thing ${n} happens tomorrow`);
      assert.equal((await receipt(n)).blitzPoints, 4, answer);
      if (n === 10) assert.match(answer, /That was your last one/);
    }
    const capped = await reply(SAM, "@receipts thing 11 happens tomorrow");
    assert.match(capped, /No blitz points: you've used all 10/);
    assert.equal((await receipt(11)).blitzPoints, undefined);

    await say(DANA, "@receipts her thing happens tomorrow");
    assert.equal((await receipt(12)).blitzPoints, 4);

    await say(SAM, "@receipts cancel 1");
    await say(SAM, "@receipts thing 13 happens tomorrow");
    assert.equal((await receipt(13)).blitzPoints, 4);
  });

  it("stop scoring when the blitz ends", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    clock.now = ENDS + 1000;
    const answer = await reply(SAM, "@receipts the Giants win tomorrow");
    assert.match(answer, /^🧾 TAKE LOCKED/);
    assert.equal((await receipt(1)).blitzPoints, undefined);
  });

  it("make tonight's takes due tomorrow morning instead of right away", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    await say(SAM, "@receipts the Giants win tonight");
    assert.equal((await receipt(1)).dueAt, dueAtFor("2026-09-26", OFFSET));
    assert.deepEqual(((await app.bot("GET", "/api/bot/due")).body as DueResponse).reminders, []);
  });
});

describe("blitz announcements", () => {
  it("wait for the blitz to end, then crown the leader for now", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ENDS - 1;
    assert.deepEqual(await announcements(), []);

    clock.now = ENDS;
    const results = {
      board: [standing(await ref(SAM), "Sam", 2, 0, 8), standing(await ref(DANA), "Dana", 2, 0, 6)],
      crown: [await ref(SAM)]
    };
    assert.equal(await deliverOne(), blitzOverMessage(results, times, await groupUrl()));
    assert.deepEqual(await announcements(), []);
  });

  it("acknowledge idempotently and reject unknown ids", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ENDS;
    const [due] = await announcements();
    assert.deepEqual(await announced(due.announcementId), { status: 200, body: { ok: true } });
    assert.deepEqual(await announced(due.announcementId), { status: 200, body: { ok: true } });
    assert.equal((await announced("nope")).status, 404);
    assert.equal((await app.bot("POST", "/api/bot/announced", {})).status, 400);
  });

  it("hand the crown over in chat as takes settle", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ENDS + HOUR;

    const stolen = await reply(ALEX, "@receipts 2 void");
    assert.match(stolen, /^➖ RECEIPT #2: VOID/);
    assert.ok(stolen.endsWith("\n\n👑 CROWN STOLEN. Dana takes it from Sam."), stolen);
    assert.equal((await receipt(2)).blitzKept, 0);

    const quiet = await reply(DANA, "@receipts 1 right");
    assert.doesNotMatch(quiet, /crown/i);
    assert.match(quiet, /Settled by 👑 Dana/);
    assert.equal((await receipt(1)).blitzKept, 4);
  });

  it("say nothing about the crown while the blitz is live", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    const answer = await reply(ALEX, "@receipts 2 void");
    assert.doesNotMatch(answer, /👑/);
    assert.equal((await receipt(2)).blitzKept, 0);
  });

  it("post crown changes from the web record book", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock, true);
    clock.now = ENDS;
    await deliverOne();

    clock.now = ENDS + HOUR;
    const two = (await receipt(2)).id as string;
    await app.mutation("settleReceipt", account("user-alex", "Alex"), two, "void", null);
    assert.equal(await deliverOne(), "👑 CROWN STOLEN. Dana takes it from Sam.");
  });

  it("give a last call with the unsettled takes", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ENDS + HOUR;
    await say(DANA, "@receipts 1 right");

    // The bridge was offline since the blitz ended: the last call supersedes the blitz-over post.
    clock.now = LAST_CALL;
    const results = {
      board: [standing(await ref(SAM), "Sam", 2, 4, 4), standing(await ref(DANA), "Dana", 2, 0, 6)],
      crown: [await ref(SAM)]
    };
    assert.equal(await deliverOne(), lastCallMessage(results, [2, 3, 4], times, await groupUrl()));
    assert.ok((await app.rows("announcements")).filter((row) => row.kind !== "anointed").every((row) => row.sentAt !== undefined));
  });

  it("anoint the crown, burn unsettled takes to half, and never change it again", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ENDS;
    await deliverOne();
    clock.now = ENDS + HOUR;
    await say(DANA, "@receipts 1 right");
    clock.now = LAST_CALL;
    await deliverOne();

    clock.now = ANOINT;
    const results = {
      board: [standing(await ref(SAM), "Sam", 2, 6, 0), standing(await ref(DANA), "Dana", 2, 3, 0)],
      crown: [await ref(SAM)]
    };
    assert.equal(await deliverOne(), anointedMessage(results, await groupUrl()));

    clock.now = ANOINT + HOUR;
    const late = await reply(ALEX, "@receipts 2 void");
    assert.doesNotMatch(late, /CROWN/);
    assert.equal((await receipt(2)).blitzKept, undefined);
    assert.deepEqual(await announcements(), []);
  });

  it("skip straight to the anointing after a long outage", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ANOINT + DAY;
    const message = await deliverOne();
    assert.match(message, /^👑 THE CROWN IS ANOINTED/);
    assert.ok((await app.rows("announcements")).every((row) => row.sentAt !== undefined));
  });

  it("wrap up quietly when nobody plays", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    clock.now = ENDS;
    assert.equal(await deliverOne(), blitzOverMessage({ board: [], crown: [] }, times, await groupUrl()));
    clock.now = LAST_CALL;
    assert.deepEqual(await announcements(), []);
    clock.now = ANOINT;
    assert.deepEqual(await announcements(), []);
  });
});

describe("the crown in bot messages", () => {
  it("is nowhere while the blitz is live", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    assert.doesNotMatch(await reply(DANA, "@receipts 1"), /👑/);
  });

  it("follows the crown holder's name once the blitz ends", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock);
    clock.now = ENDS + HOUR;
    assert.match(await reply(DANA, "@receipts 1"), /\n👑 Sam:\n/);
    assert.match(await reply(DANA, "@receipts list"), /#1 👑 Sam: /);
    assert.doesNotMatch(await reply(DANA, "@receipts 3"), /👑/);
    const reminders = ((await app.bot("GET", "/api/bot/due")).body as DueResponse).reminders;
    assert.ok(reminders.some((reminder) => reminder.message.includes("👑 Sam said")), JSON.stringify(reminders));
  });

  it("can't be claimed with a name", async (t) => {
    useClock(t);
    assert.match(await reply(SAM, "@receipts call me 👑 Sam"), /Nice try/);
  });
});

describe("the blitz in the record book", () => {
  const SAM_ACCOUNT = account("user-sam", "Sam");

  it("shows the board and the crown", async (t) => {
    const clock = useClock(t);
    await playBlitz(clock, true);
    const id = (await groupRow()).id as string;

    const live = await app.query("group", SAM_ACCOUNT, id);
    assert.deepEqual(live?.blitz, {
      phase: "live",
      startedAt: START,
      endsAt: ENDS,
      anointAt: ANOINT,
      board: [standing("u:user-sam", "Sam", 2, 0, 8), standing("u:user-dana", "Dana", 2, 0, 6)],
      crown: []
    });

    clock.now = ENDS;
    const provisional = await app.query("group", SAM_ACCOUNT, id);
    assert.equal(provisional?.blitz?.phase, "provisional");
    assert.deepEqual(provisional?.blitz?.crown, ["u:user-sam"]);
    assert.ok(provisional?.standings.every((row) => row.takeScore === 0), "blitz points stay off the Take Score");

    assert.equal((await app.query("profile", SAM_ACCOUNT, id, "u:user-sam"))?.crowned, true);
    assert.equal((await app.query("profile", SAM_ACCOUNT, id, "u:user-dana"))?.crowned, false);
  });

  it("has no blitz until someone sends lfg", async (t) => {
    useClock(t);
    await meetTheGroup(true);
    const id = (await groupRow()).id as string;
    assert.equal((await app.query("group", SAM_ACCOUNT, id))?.blitz, null);
    assert.equal((await app.query("profile", SAM_ACCOUNT, id, "u:user-sam"))?.crowned, false);
  });
});
