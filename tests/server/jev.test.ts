import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import { LogBuffer } from "lakebed/runtime";
import { jevGrader } from "../../app/server/jev";
import { blitzTakeMessage } from "../../app/shared/format";
import { TAKE_GRADE_QUESTIONS, takeGradeRequest, TYPESAFE_URL, type GradeDimension, type TakeGrade } from "../../app/shared/jev";
import { account, APP_URL, BOT_SECRET, TestApp, tokenFrom } from "./harness";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 8:14pm PDT on Friday, Sep 25 2026.
const START = Date.UTC(2026, 8, 26, 3, 14);
const API_KEY = "ts-test-key";

const SAM = "+15555550111";
const DANA = "+15555550222";

type FetchCall = { url: string; init: RequestInit; body: unknown };
type FetchHandler = (call: FetchCall) => Promise<Response>;

/** Replaces global fetch for the test, recording every call. */
function mockFetch(t: TestContext, handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  // Node defines fetch lazily; reading it once turns it into a plain method that can be mocked.
  void globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

/** A System One response placing each answer at `scores` on its question's levels. */
function jevResponse(scores: Record<GradeDimension, number>, model = "jev-1.13.0"): Response {
  const answers = Object.fromEntries(
    (Object.keys(scores) as GradeDimension[]).map((dimension) => {
      const levels = TAKE_GRADE_QUESTIONS[dimension].criteria.length;
      const level = (index: number) => [String(index), index === Math.round(scores[dimension]) ? 1 : 0];
      return [
        dimension,
        {
          type: "score",
          score: scores[dimension],
          legend: Object.fromEntries(TAKE_GRADE_QUESTIONS[dimension].criteria.map((text, index) => [String(index), text])),
          probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => level(index))),
          confidence: 0.9
        }
      ];
    })
  );
  return Response.json({ model, answers, usage: { input_tokens: 420, output_tokens: 30 } });
}

/** A clear-cut long shot that starts a real debate. */
const LONG_SHOT = { boldness: 4, spice: 2, clarity: 3 };
const LONG_SHOT_GRADE: TakeGrade = { boldness: 1, spice: 0.67, clarity: 1 };

function useClock(t: TestContext, start = START - HOUR): { now: number } {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

describe("jevGrader", () => {
  const take = { take: "The Giants win", due: "by the end of today" };
  let logs: LogBuffer;

  beforeEach(() => {
    logs = new LogBuffer();
  });

  it("needs an API key", () => {
    assert.equal(jevGrader(undefined, logs.createLogger()), undefined);
    assert.equal(jevGrader("", logs.createLogger()), undefined);
    assert.equal(jevGrader("   ", logs.createLogger()), undefined);
  });

  it("asks Jev every grading question in one request and reads the grade", async (t) => {
    const calls = mockFetch(t, async () => jevResponse(LONG_SHOT));
    const grade = await jevGrader(API_KEY, logs.createLogger())?.(take);

    assert.deepEqual(grade, LONG_SHOT_GRADE);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, TYPESAFE_URL);
    assert.equal(call.init.method, "POST");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(call.body, takeGradeRequest(take));
  });

  it("logs which model answered, but never the take", async (t) => {
    mockFetch(t, async () => jevResponse(LONG_SHOT, "jev-1.13.0"));
    await jevGrader(API_KEY, logs.createLogger())?.(take);
    const entry = logs.entries.find((candidate) => candidate.message === "jev grade");
    assert.ok(entry, JSON.stringify(logs.entries));
    assert.deepEqual(entry.data, { model: "jev-1.13.0", temp: 90 });
    assert.doesNotMatch(JSON.stringify(logs.entries), /Giants/);
  });

  for (const status of [401, 422, 429, 500, 529]) {
    it(`gives up on HTTP ${status}`, async (t) => {
      mockFetch(t, async () => Response.json({ error: "nope" }, { status }));
      assert.equal(await jevGrader(API_KEY, logs.createLogger())?.(take), null);
      assert.ok(logs.entries.some((entry) => entry.level === "warn" && JSON.stringify(entry.data).includes(String(status))));
    });
  }

  it("gives up when the request fails", async (t) => {
    mockFetch(t, async () => {
      throw new TypeError("fetch failed");
    });
    assert.equal(await jevGrader(API_KEY, logs.createLogger())?.(take), null);
    assert.ok(logs.entries.some((entry) => entry.level === "warn"));
  });

  it("gives up on a response it can't read", async (t) => {
    const bodies = [new Response("<html>oops</html>", { status: 200 }), Response.json({ model: "jev-1.13.0", answers: {} })];
    mockFetch(t, async () => bodies.shift() ?? Response.json(null));
    const grade = jevGrader(API_KEY, logs.createLogger());
    assert.equal(await grade?.(take), null);
    assert.equal(await grade?.(take), null);
    assert.equal(logs.entries.filter((entry) => entry.level === "warn").length, 2);
  });

  it("gives up when Jev is slow", { timeout: 2000 }, async (t) => {
    const calls = mockFetch(
      t,
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          // AbortSignal.timeout doesn't keep the process alive on its own; a server would.
          const alive = setTimeout(() => reject(new Error("never aborted")), 1000);
          call.init.signal?.addEventListener("abort", () => {
            clearTimeout(alive);
            reject(call.init.signal?.reason);
          });
        })
    );
    assert.equal(await jevGrader(API_KEY, logs.createLogger(), { timeoutMs: 20 })?.(take), null);
    assert.ok(calls[0].init.signal, "the request can be aborted");
  });
});

describe("temp checks for blitz takes", () => {
  let app: TestApp;

  beforeEach(() => {
    app = new TestApp({ RECEIPTS_BOT_SECRET: BOT_SECRET, APP_URL, TYPESAFE_API_KEY: API_KEY });
  });

  async function say(handle: string, text: string): Promise<string | null> {
    return (await app.chat(text, { senderHandle: handle })).reply;
  }

  /** Sam and Dana pick names; Sam sends "@receipts lfg" at START and the clock moves a minute in. */
  async function startBlitz(clock: { now: number }): Promise<void> {
    await say(SAM, "@receipts call me Sam");
    await say(DANA, "@receipts call me Dana");
    clock.now = START;
    await app.chat("@receipts lfg", { senderHandle: SAM, sentAt: START });
    clock.now = START + MINUTE;
  }

  async function receipt(number: number): Promise<Record<string, unknown>> {
    const row = (await app.rows("receipts")).find((candidate) => candidate.number === number);
    assert.ok(row, `receipt #${number}`);
    return row;
  }

  it("checks a take's temp the moment it's logged", async (t) => {
    const clock = useClock(t);
    const calls = mockFetch(t, async () => jevResponse(LONG_SHOT));
    await startBlitz(clock);

    const answer = await say(SAM, "@receipts the Giants win tonight");
    assert.equal(
      answer,
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
        { late: false, grade: LONG_SHOT_GRADE }
      )
    );
    assert.match(answer ?? "", /Temp check: 90°/);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0].body as { state: unknown }).state, { take: "The Giants win", due: "by the end of today" });

    const row = await receipt(1);
    assert.equal(row.jevBoldness, 1);
    assert.equal(row.jevSpice, 0.67);
    assert.equal(row.jevClarity, 1);
    assert.equal(row.blitzPoints, 4);
  });

  it("grades the exact message behind a self-reply take", async (t) => {
    const clock = useClock(t);
    const calls = mockFetch(t, async () => jevResponse(LONG_SHOT));
    await startBlitz(clock);

    const answer = await app.reply("@receipts #take by tomorrow", { text: "I'm running a marathon", authorHandle: SAM }, { senderHandle: SAM });
    assert.match(answer.reply ?? "", /Temp check: 90°/);
    assert.deepEqual((calls[0].body as { state: unknown }).state, { take: "I'm running a marathon", due: "by the end of tomorrow" });
    assert.equal((await receipt(1)).jevBoldness, 1);
  });

  it("grades takes that earn no blitz points", async (t) => {
    const clock = useClock(t);
    const calls = mockFetch(t, async () => jevResponse(LONG_SHOT));
    await startBlitz(clock);

    const answer = await say(SAM, "@receipts the Mets win the World Series by Oct 31 2026");
    assert.match(answer ?? "", /No blitz points/);
    assert.match(answer ?? "", /Temp check/);
    assert.deepEqual((calls[0].body as { state: unknown }).state, {
      take: "The Mets win the World Series",
      due: "within 5 weeks"
    });
  });

  it("only grades takes people log about themselves during the blitz", async (t) => {
    const clock = useClock(t);
    const calls = mockFetch(t, async () => jevResponse(LONG_SHOT));
    await say(SAM, "@receipts call me Sam");
    await say(SAM, "@receipts the Giants win tonight");
    assert.equal(calls.length, 0, "before the blitz");

    await startBlitz(clock);
    await say(SAM, "@receipts Dana says the Knicks win tomorrow");
    await say(SAM, "@receipts #promise I bring the grill by Sep 27 2026");
    await app.reply("@receipts #take by tomorrow", { text: "Sam is late again", authorHandle: DANA }, { senderHandle: SAM });
    await app.reply("@receipts told you so", { text: "I said the Jets would lose", authorHandle: SAM }, { senderHandle: SAM });
    assert.equal(calls.length, 0, "about others, not takes, or callouts");

    clock.now = START + DAY + MINUTE;
    await app.chat("@receipts the Jets lose tomorrow", { senderHandle: SAM, sentAt: clock.now - 1000 });
    assert.equal(calls.length, 0, "after the window");
  });

  it("logs the take without a temp check when Jev is down", async (t) => {
    const clock = useClock(t);
    mockFetch(t, async () => Response.json({ error: "overloaded" }, { status: 529 }));
    await startBlitz(clock);

    const answer = await say(SAM, "@receipts the Giants win tonight");
    assert.doesNotMatch(answer ?? "", /Temp check/);
    assert.match(answer ?? "", /#1 LOCKED · Sam \+4/);
    const row = await receipt(1);
    assert.equal(row.blitzPoints, 4);
    assert.equal(row.jevBoldness, undefined);
  });

  it("skips grading without an API key", async (t) => {
    app = new TestApp();
    const clock = useClock(t);
    const calls = mockFetch(t, async () => jevResponse(LONG_SHOT));
    await startBlitz(clock);

    const answer = await say(SAM, "@receipts the Giants win tonight");
    assert.doesNotMatch(answer ?? "", /Temp check/);
    assert.equal(calls.length, 0);
  });

  it("shows the temp check in the record book", async (t) => {
    const clock = useClock(t);
    mockFetch(t, async () => jevResponse(LONG_SHOT));
    const sam = account("user-sam", "Sam");
    await say(SAM, "@receipts call me Sam");
    await app.mutation("redeemInvite", sam, tokenFrom(await say(SAM, "@receipts join")));
    await say(SAM, "@receipts the Jets lose tomorrow");
    await startBlitz(clock);
    await say(SAM, "@receipts the Giants win tonight");

    const [group] = await app.rows("groups");
    const graded = await app.query("receipt", sam, String(group.id), 2);
    assert.deepEqual(graded?.card.tempCheck, LONG_SHOT_GRADE);
    const ungraded = await app.query("receipt", sam, String(group.id), 1);
    assert.equal(ungraded?.card.tempCheck, null);
  });
});
