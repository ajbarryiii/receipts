import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import type { ReplySource } from "../../app/shared/bot-api";
import { exposedMessage, toldYouSoMessage, type ChatReceipt } from "../../app/shared/format";
import type { BlitzStanding } from "../../app/shared/types";
import { account, TestApp, tokenFrom } from "./harness";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 8:14pm PDT on Friday, Sep 25 2026.
const START = Date.UTC(2026, 8, 26, 3, 14);
const ENDS = START + DAY;
const ANOINT = START + 7 * DAY;
// 7pm on Monday, Mar 4 2024, in the bridge's -420 offset.
const OLD = Date.UTC(2024, 2, 5, 2, 0);

const SAM = "+15555550111";
const DANA = "+15555550222";
const ALEX = "+15555550333";
const PEOPLE: [string, string][] = [
  [SAM, "Sam"],
  [DANA, "Dana"],
  [ALEX, "Alex"]
];
const SAM_ACCOUNT = account("user-sam", "Sam");

type Clock = { now: number };

function useClock(t: TestContext, start = START - HOUR): Clock {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

let app: TestApp;
let sources = 0;

beforeEach(() => {
  app = new TestApp();
});

async function say(handle: string, text: string): Promise<string> {
  const { reply } = await app.chat(text, { senderHandle: handle });
  assert.ok(reply, `no reply to ${text}`);
  return reply;
}

/** `handle` replies with `text` to an old message by `author`. */
async function replyTo(handle: string, text: string, author: string, said: string, source: Partial<ReplySource> = {}): Promise<string> {
  sources += 1;
  const { reply } = await app.reply(
    text,
    { messageGuid: `old-${sources}`, text: said, authorHandle: author, sentAt: OLD, ...source },
    { senderHandle: handle }
  );
  assert.ok(reply, `no reply to ${text}`);
  return reply;
}

async function meetTheGroup(accounts = false): Promise<void> {
  for (const [handle, name] of PEOPLE) {
    await say(handle, `@receipts call me ${name}`);
    if (accounts) {
      await app.mutation("redeemInvite", account(`user-${name.toLowerCase()}`, name), tokenFrom(await say(handle, "@receipts join")));
    }
  }
}

async function startBlitz(clock: Clock): Promise<void> {
  clock.now = START;
  await say(SAM, "@receipts lfg");
  clock.now = START + MINUTE;
}

async function receipt(number: number): Promise<Record<string, unknown>> {
  const row = (await app.rows("receipts")).find((candidate) => candidate.number === number);
  assert.ok(row, `receipt #${number}`);
  return row;
}

async function identityId(handle: string): Promise<string> {
  const identity = (await app.rows("identities")).find((row) => row.handle === handle);
  assert.ok(identity, `identity ${handle}`);
  return identity.id as string;
}

async function board(): Promise<BlitzStanding[]> {
  const [group] = await app.rows("groups");
  const view = await app.query("group", SAM_ACCOUNT, group.id as string);
  assert.ok(view?.blitz, "the group has a blitz");
  return view.blitz.board;
}

function standing(name: string, takes: number, banked: number, tab: number): BlitzStanding {
  return { subjectRef: `u:user-${name.toLowerCase()}`, name, takes, banked, tab, total: banked + tab };
}

const DANA_TAKE = "No way the Knicks make the playoffs.";
const SAM_TAKE = "The Knicks make the playoffs";

function oldTake(number: number, subjectName: string, statement: string): ChatReceipt {
  return {
    number,
    type: "take",
    status: "pending",
    capture: "reply",
    subjectName,
    statement,
    madeOn: "2024-03-04",
    deadline: null,
    dateAmbiguous: false,
    heat: null
  };
}

describe("@receipts exposed", () => {
  it("puts someone's old take on the record as theirs, no acceptance needed", async (t) => {
    useClock(t);
    await meetTheGroup();
    const answer = await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);
    assert.equal(answer, exposedMessage(oldTake(1, "Dana", DANA_TAKE), { exposerName: "Sam", blitz: null, late: false }));

    const row = await receipt(1);
    assert.equal(row.type, "take");
    assert.equal(row.status, "pending");
    assert.equal(row.capture, "reply");
    assert.equal(row.callout, "exposed");
    assert.equal(row.statement, DANA_TAKE);
    assert.equal(row.madeOn, "2024-03-04");
    assert.equal(row.subjectIdentityId, await identityId(DANA));
    assert.equal(row.createdByIdentityId, await identityId(SAM));
    assert.equal(row.nominatedAt, undefined);
    assert.equal(row.deadline, undefined);
    assert.equal(row.blitzPoints, undefined);
  });

  it("can't be settled by the author or the exposer", async (t) => {
    useClock(t);
    await meetTheGroup();
    await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);
    assert.match(await say(DANA, "@receipts 1 right"), /can't settle your own/);
    assert.match(await say(SAM, "@receipts 1 wrong"), /You exposed this one/);
    assert.match(await say(ALEX, "@receipts 1 wrong"), /^❌ RECEIPT #1: WRONG/);
  });

  it("points at a message that's already on the record", async (t) => {
    useClock(t);
    await meetTheGroup();
    await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE, { messageGuid: "old-dana" });
    assert.equal(await replyTo(ALEX, "@receipts exposed", DANA, DANA_TAKE, { messageGuid: "old-dana" }), "🧾 That's already Receipt #1.");
    assert.equal((await app.rows("receipts")).length, 1);
  });

  it("won't expose yourself", async (t) => {
    useClock(t);
    await meetTheGroup();
    assert.match(await replyTo(SAM, "@receipts exposed", SAM, SAM_TAKE), /told you so/);
    assert.equal((await app.rows("receipts")).length, 0);
  });

  it("needs a message to expose", async (t) => {
    useClock(t);
    await meetTheGroup();
    assert.match(await say(SAM, "@receipts exposed"), /Reply to the message/);
    assert.equal((await app.rows("receipts")).length, 0);
  });
});

describe("@receipts told you so", () => {
  it("puts your own old take on the record for the group to confirm", async (t) => {
    useClock(t);
    await meetTheGroup();
    const answer = await replyTo(SAM, "@receipts told you so", SAM, SAM_TAKE);
    assert.equal(answer, toldYouSoMessage(oldTake(1, "Sam", SAM_TAKE), { blitz: null, late: false }));

    const row = await receipt(1);
    assert.equal(row.status, "pending");
    assert.equal(row.callout, "told_you_so");
    assert.equal(row.subjectIdentityId, await identityId(SAM));
    assert.equal(row.createdByIdentityId, await identityId(SAM));
    assert.equal(row.deadline, undefined);
  });

  it("also answers to called it", async (t) => {
    useClock(t);
    await meetTheGroup();
    await replyTo(SAM, "@receipts called it", SAM, SAM_TAKE);
    assert.equal((await receipt(1)).callout, "told_you_so");
  });

  it("is settled by someone else", async (t) => {
    useClock(t);
    await meetTheGroup();
    await replyTo(SAM, "@receipts told you so", SAM, SAM_TAKE);
    assert.match(await say(SAM, "@receipts 1 right"), /can't settle your own/);
    assert.match(await say(DANA, "@receipts 1 right"), /^✅ RECEIPT #1: RIGHT/);
  });

  it("only works on your own messages", async (t) => {
    useClock(t);
    await meetTheGroup();
    assert.match(await replyTo(SAM, "@receipts told you so", DANA, DANA_TAKE), /not your message/);
    assert.match(await say(SAM, "@receipts told you so"), /Reply to your own message/);
    assert.equal((await app.rows("receipts")).length, 0);
  });

  it("shows on the record book's cards", async (t) => {
    useClock(t);
    await meetTheGroup(true);
    await replyTo(SAM, "@receipts told you so", SAM, SAM_TAKE);
    await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);
    const [group] = await app.rows("groups");
    const view = await app.query("group", SAM_ACCOUNT, group.id as string);
    assert.deepEqual(
      view?.pending.map((card) => [card.number, card.callout]),
      [
        [2, { kind: "exposed", byName: "Sam" }],
        [1, { kind: "told_you_so", byName: "Sam" }]
      ]
    );
  });
});

describe("callouts in the blitz", () => {
  it("cost an exposed author 2 points when they were wrong", async (t) => {
    const clock = useClock(t);
    await meetTheGroup(true);
    await startBlitz(clock);
    await say(DANA, "@receipts the Giants win tonight");
    const answer = await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);
    assert.ok(answer.endsWith("If it was wrong, Dana loses 2 blitz points. Sam has 9 takes left."), answer);
    assert.equal((await receipt(2)).blitzPoints, 2);
    assert.deepEqual(await board(), [standing("Dana", 1, 0, 4)]);

    await say(ALEX, "@receipts 2 wrong");
    assert.equal((await receipt(2)).blitzKept, -2);
    assert.deepEqual(await board(), [standing("Dana", 1, -2, 4)]);
  });

  it("cost nothing when the author was right, or when nobody settles them", async (t) => {
    const clock = useClock(t);
    await meetTheGroup(true);
    await startBlitz(clock);
    await say(DANA, "@receipts the Giants win tonight");
    await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);
    await replyTo(SAM, "@receipts exposed", DANA, "Pineapple on pizza is a crime.");
    await say(ALEX, "@receipts 2 right");
    assert.equal((await receipt(2)).blitzKept, 0);

    clock.now = ANOINT;
    // Dana's unsettled take keeps half; the unsettled exposé (#3) costs nothing.
    assert.deepEqual(await board(), [standing("Dana", 1, 2, 0)]);
  });

  it("score a told-you-so as a flat 2, like any blitz take", async (t) => {
    const clock = useClock(t);
    await meetTheGroup(true);
    await startBlitz(clock);
    await say(SAM, "@receipts the Giants win tonight");
    const answer = await replyTo(SAM, "@receipts told you so", SAM, SAM_TAKE);
    assert.ok(answer.endsWith("Sam +2 if it holds up · blitz total: 6 · 8 takes left"), answer);
    await replyTo(SAM, "@receipts told you so", SAM, "The Jets win a playoff game.");
    assert.deepEqual(await board(), [standing("Sam", 3, 0, 8)]);

    await say(DANA, "@receipts 2 right");
    await say(DANA, "@receipts 3 wrong");
    assert.deepEqual([(await receipt(2)).blitzKept, (await receipt(3)).blitzKept], [2, 1]);
    assert.deepEqual(await board(), [standing("Sam", 3, 3, 4)]);
  });

  it("share the 10-take limit", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    for (let n = 1; n <= 9; n += 1) {
      await say(SAM, `@receipts thing ${n} happens tomorrow`);
    }
    assert.ok((await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE)).endsWith("That was Sam's last one."));
    const capped = await replyTo(SAM, "@receipts told you so", SAM, SAM_TAKE);
    assert.ok(capped.endsWith("No blitz points: you've used all 10."), capped);
    assert.equal((await receipt(11)).blitzPoints, undefined);
  });

  it("only score during the blitz window", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    clock.now = ENDS + MINUTE;
    const answer = await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);
    assert.doesNotMatch(answer, /blitz/);
    assert.equal((await receipt(1)).blitzPoints, undefined);
  });

  it("can knock the crown loose", async (t) => {
    const clock = useClock(t);
    await meetTheGroup();
    await startBlitz(clock);
    await say(DANA, "@receipts the Giants win tonight");
    await say(SAM, "@receipts it rains by Sep 30 2026");
    await replyTo(SAM, "@receipts exposed", DANA, DANA_TAKE);

    clock.now = ENDS + HOUR;
    const settled = await say(ALEX, "@receipts 3 wrong");
    assert.ok(settled.endsWith("\n\n👑 Sam ties Dana for the crown."), settled);
  });
});
