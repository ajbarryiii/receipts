import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLITZ_TAKE_CAP,
  CALLOUT_POINTS,
  blitzBoard,
  blitzPhase,
  blitzPoints,
  blitzSchedule,
  crownHolders,
  defaultBlitzDeadline,
  keptPoints,
  LIGHTNING_POINTS,
  WEEK_POINTS,
  type BlitzEntry
} from "../../app/shared/blitz";
import { dueAtFor } from "../../app/shared/dates";
import {
  anointedMessage,
  blitzOverMessage,
  blitzStartMessage,
  blitzStatusMessage,
  blitzTakeMessage,
  crownChangeMessage,
  crownedName,
  exposedMessage,
  joinNames,
  lastCallMessage,
  toldYouSoMessage,
  type BlitzResults,
  type ChatReceipt
} from "../../app/shared/format";
import { parseBotMessage } from "../../app/shared/parse";
import type { BlitzStanding } from "../../app/shared/types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OFFSET = -420;
// 8:14pm PDT on Friday, Sep 25 2026.
const START = Date.UTC(2026, 8, 26, 3, 14);
const TODAY = "2026-09-25";
const schedule = blitzSchedule(START);
const times = { endsAt: schedule.endsAt, anointAt: schedule.anointAt, utcOffsetMinutes: OFFSET };

function points(deadline: string, today = TODAY, from = schedule): number {
  return blitzPoints({ deadline, dueAt: dueAtFor(deadline, OFFSET) }, today, from);
}

function entry(subjectRef: string, name: string, overrides: Partial<BlitzEntry> = {}): BlitzEntry {
  return { subjectRef, name, status: "pending", points: LIGHTNING_POINTS, kept: null, exposed: false, ...overrides };
}

function standing(subjectRef: string, name: string, takes: number, banked: number, tab: number): BlitzStanding {
  return { subjectRef, name, takes, banked, tab, total: banked + tab };
}

describe("blitz schedule", () => {
  it("runs a 24-hour window, a last call on day 6, and the anointing on day 7", () => {
    assert.deepEqual(schedule, {
      startedAt: START,
      endsAt: START + DAY,
      lastCallAt: START + 6 * DAY,
      anointAt: START + 7 * DAY
    });
  });

  it("is live for 24 hours, provisional until the anointing, then final", () => {
    assert.equal(blitzPhase(schedule, START), "live");
    assert.equal(blitzPhase(schedule, START + DAY - 1), "live");
    assert.equal(blitzPhase(schedule, START + DAY), "provisional");
    assert.equal(blitzPhase(schedule, START + 7 * DAY - 1), "provisional");
    assert.equal(blitzPhase(schedule, START + 7 * DAY), "final");
  });
});

describe("blitz points", () => {
  it("pays the most for takes due today or tomorrow", () => {
    assert.equal(points("2026-09-25"), LIGHTNING_POINTS);
    assert.equal(points("2026-09-26"), LIGHTNING_POINTS);
  });

  it("pays less for takes due before the anointing", () => {
    assert.equal(points("2026-09-27"), WEEK_POINTS);
    assert.equal(points("2026-10-01"), WEEK_POINTS);
    // Due at 10am on the anointing day, before the 8:14pm anointing.
    assert.equal(points("2026-10-02"), WEEK_POINTS);
  });

  it("pays nothing for takes due after the anointing or already past", () => {
    assert.equal(points("2026-10-03"), 0);
    assert.equal(points("2027-10-01"), 0);
    assert.equal(points("2026-09-24"), 0);
  });

  it("measures lightning from the day the take was made", () => {
    assert.equal(points("2026-09-27", "2026-09-26"), LIGHTNING_POINTS);
  });

  it("pays nothing for a take due on the anointing day after the anointing", () => {
    // Started at 9am, so the anointing at 9am on Oct 2 comes before that day's 10am due time.
    const morning = blitzSchedule(Date.UTC(2026, 8, 25, 16, 0));
    assert.equal(points("2026-10-02", TODAY, morning), 0);
    assert.equal(points("2026-10-01", TODAY, morning), WEEK_POINTS);
  });

  it("dates undated takes the day before the anointing", () => {
    assert.equal(defaultBlitzDeadline(schedule, OFFSET), "2026-10-01");
    assert.equal(points(defaultBlitzDeadline(schedule, OFFSET)), WEEK_POINTS);
  });

  it("keeps everything when right, half when wrong, nothing when void", () => {
    assert.equal(keptPoints(LIGHTNING_POINTS, "right"), 4);
    assert.equal(keptPoints(LIGHTNING_POINTS, "wrong"), 2);
    assert.equal(keptPoints(WEEK_POINTS, "wrong"), 1);
    assert.equal(keptPoints(WEEK_POINTS, "void"), 0);
  });

  it("caps point-earning takes at 10 per person", () => {
    assert.equal(BLITZ_TAKE_CAP, 10);
  });

  it("puts a flat 2 on callouts", () => {
    assert.equal(CALLOUT_POINTS, 2);
  });

  it("costs an exposed author only when they were wrong", () => {
    assert.equal(keptPoints(CALLOUT_POINTS, "wrong", true), -2);
    assert.equal(keptPoints(CALLOUT_POINTS, "right", true), 0);
    assert.equal(keptPoints(CALLOUT_POINTS, "void", true), 0);
  });
});

describe("blitzBoard", () => {
  const entries: BlitzEntry[] = [
    entry("i:sam", "Sam"),
    entry("i:sam", "Sam", { status: "right", kept: 4 }),
    entry("i:sam", "Sam", { status: "wrong", points: WEEK_POINTS, kept: 1 }),
    entry("i:dana", "Dana", { points: WEEK_POINTS }),
    entry("i:dana", "Dana", { points: WEEK_POINTS }),
    entry("i:dana", "Dana", { points: WEEK_POINTS }),
    entry("i:dana", "Dana", { status: "canceled" }),
    entry("i:alex", "Alex", { status: "void", kept: 0 })
  ];

  it("banks settled takes and keeps unsettled ones on the tab at full value", () => {
    assert.deepEqual(blitzBoard(entries, "provisional"), [
      standing("i:sam", "Sam", 3, 5, 4),
      standing("i:dana", "Dana", 3, 0, 6),
      standing("i:alex", "Alex", 1, 0, 0)
    ]);
    assert.deepEqual(blitzBoard(entries, "live"), blitzBoard(entries, "provisional"));
  });

  it("gives unsettled takes half once the crown is anointed", () => {
    assert.deepEqual(blitzBoard(entries, "final"), [
      standing("i:sam", "Sam", 3, 7, 0),
      standing("i:dana", "Dana", 3, 3, 0),
      standing("i:alex", "Alex", 1, 0, 0)
    ]);
  });

  it("breaks ties by takes, then name", () => {
    const tied = [
      entry("i:zoe", "Zoe", { points: WEEK_POINTS }),
      entry("i:zoe", "Zoe", { points: WEEK_POINTS }),
      entry("i:bo", "Bo"),
      entry("i:al", "Al")
    ];
    assert.deepEqual(
      blitzBoard(tied, "live").map((row) => row.name),
      ["Zoe", "Al", "Bo"]
    );
  });

  it("charges settled exposés to their author without counting them as takes", () => {
    const exposed = [
      entry("i:dana", "Dana"),
      entry("i:dana", "Dana", { points: CALLOUT_POINTS, exposed: true, status: "wrong", kept: -2 }),
      entry("i:dana", "Dana", { points: CALLOUT_POINTS, exposed: true, status: "right", kept: 0 }),
      entry("i:dana", "Dana", { points: CALLOUT_POINTS, exposed: true }),
      entry("i:alex", "Alex", { points: CALLOUT_POINTS, exposed: true, status: "wrong", kept: -2 })
    ];
    assert.deepEqual(blitzBoard(exposed, "provisional"), [standing("i:dana", "Dana", 1, -2, 4), standing("i:alex", "Alex", 0, -2, 0)]);
    // At the anointing Dana's unsettled take keeps half; the unsettled exposé still costs nothing.
    assert.deepEqual(blitzBoard(exposed, "final"), [standing("i:dana", "Dana", 1, 0, 0), standing("i:alex", "Alex", 0, -2, 0)]);
  });

  it("uses the latest name for a person", () => {
    const renamed = [entry("i:sam", "Sammy"), entry("i:sam", "Sam")];
    assert.equal(blitzBoard(renamed, "live")[0].takes, 2);
  });
});

describe("crownHolders", () => {
  const board = [standing("i:sam", "Sam", 2, 0, 8), standing("i:dana", "Dana", 3, 0, 6)];

  it("has no crown while the blitz is live", () => {
    assert.deepEqual(crownHolders(board, "live"), []);
  });

  it("crowns the leader afterwards", () => {
    assert.deepEqual(crownHolders(board, "provisional"), ["i:sam"]);
    assert.deepEqual(crownHolders(board, "final"), ["i:sam"]);
  });

  it("shares the crown on a tie", () => {
    const tied = [standing("i:sam", "Sam", 2, 0, 6), standing("i:dana", "Dana", 3, 0, 6), standing("i:alex", "Alex", 1, 0, 2)];
    assert.deepEqual(crownHolders(tied, "final").sort(), ["i:dana", "i:sam"]);
  });

  it("crowns nobody without a point", () => {
    assert.deepEqual(crownHolders([standing("i:alex", "Alex", 1, 0, 0)], "final"), []);
    assert.deepEqual(crownHolders([standing("i:alex", "Alex", 0, -2, 0)], "final"), []);
    assert.deepEqual(crownHolders([], "final"), []);
  });
});

describe("blitz copy", () => {
  const samTake: ChatReceipt = {
    number: 14,
    type: "take",
    status: "pending",
    capture: "manual",
    subjectName: "Sam",
    statement: "The Giants win",
    madeOn: TODAY,
    deadline: "2026-09-25",
    dateAmbiguous: false,
    heat: null
  };
  const results: BlitzResults = {
    board: [standing("i:sam", "Sam", 5, 4, 14), standing("i:dana", "Dana", 3, 0, 6)],
    crown: ["i:sam"]
  };
  const url = "https://receipts.test/g/g1";

  it("crowns names", () => {
    assert.equal(crownedName("Dana", true), "👑 Dana");
    assert.equal(crownedName("Dana", false), "Dana");
  });

  it("joins names", () => {
    assert.equal(joinNames([]), "");
    assert.equal(joinNames(["Sam"]), "Sam");
    assert.equal(joinNames(["Sam", "Dana"]), "Sam & Dana");
    assert.equal(joinNames(["Sam", "Dana", "Alex"]), "Sam, Dana & Alex");
  });

  it("opens the blitz loudly, with the rules and both deadlines", () => {
    const message = blitzStartMessage(times, { url: "https://receipts.test/join/ABC", expiresInDays: 7 });
    assert.equal(message.split("\n")[0], "🚨 24 HOUR TAKE BLITZ ACTIVATED 🚨");
    assert.match(message, /Up to 10 each/);
    assert.match(message, /today or tomorrow: 4 pts/);
    assert.match(message, /before the 👑 is anointed: 2 pts/);
    assert.match(message, /Wrong takes keep half/);
    assert.match(message, /Blitz ends Sep 26, 2026 at 8:14pm/);
    assert.match(message, /The 👑 is anointed Oct 2, 2026 at 8:14pm/);
    assert.match(message, /https:\/\/receipts\.test\/join\/ABC/);
    assert.match(message, /7 days/);
  });

  it("teaches a take the bot logs as the sender's own", () => {
    const message = blitzStartMessage(times, { url: "https://receipts.test/join/ABC", expiresInDays: 7 });
    const example = /"(@receipts [^"]+)"/.exec(message)?.[1];
    assert.ok(example, "the opener shows an example take");
    const parsed = parseBotMessage(example, TODAY);
    assert.equal(parsed.kind, "create", example);
    if (parsed.kind === "create") {
      assert.deepEqual(parsed.draft.subject, { kind: "sender" });
      assert.equal(parsed.draft.type, "take");
    }
  });

  it("answers a repeated lfg with where the blitz stands", () => {
    assert.match(blitzStatusMessage("live", times, []), /already on/);
    assert.match(blitzStatusMessage("live", times, []), /Sep 26, 2026 at 8:14pm/);
    const provisional = blitzStatusMessage("provisional", times, ["Sam"]);
    assert.match(provisional, /Oct 2, 2026 at 8:14pm/);
    assert.match(provisional, /👑 Sam/);
    const final = blitzStatusMessage("final", times, ["Sam", "Dana"]);
    assert.match(final, /Sam & Dana/);
    assert.match(final, /👑/);
    assert.match(blitzStatusMessage("final", times, []), /Nobody/);
  });

  it("confirms a lightning take in three lines", () => {
    const message = blitzTakeMessage(samTake, { points: 4, total: 18, left: 7, blocked: null }, { late: false });
    assert.deepEqual(message.split("\n"), [
      "🧾 #14 LOCKED · Sam +4 ⚡",
      '"The Giants win."',
      "Due: Sep 25, 2026 · Sam's blitz total: 18 · 7 takes left"
    ]);
  });

  it("shows the temp check under the take", () => {
    const grade = { boldness: 1, spice: 0.67, clarity: 1 };
    const message = blitzTakeMessage(samTake, { points: 4, total: 18, left: 7, blocked: null }, { late: false, grade });
    assert.deepEqual(message.split("\n"), [
      "🧾 #14 LOCKED · Sam +4 ⚡",
      '"The Giants win."',
      "🌡️ Temp check: 90° · long shot · spicy · clear-cut",
      "Due: Sep 25, 2026 · Sam's blitz total: 18 · 7 takes left"
    ]);
    assert.equal(
      blitzTakeMessage(samTake, { points: 4, total: 18, left: 7, blocked: null }, { late: false, grade: null }),
      blitzTakeMessage(samTake, { points: 4, total: 18, left: 7, blocked: null }, { late: false })
    );
  });

  it("confirms a week take without the lightning", () => {
    const message = blitzTakeMessage({ ...samTake, deadline: "2026-09-30" }, { points: 2, total: 2, left: 9, blocked: null }, { late: false });
    assert.equal(message.split("\n")[0], "🧾 #14 LOCKED · Sam +2");
  });

  it("says when a take was the last one that scores", () => {
    const message = blitzTakeMessage(samTake, { points: 4, total: 40, left: 0, blocked: null }, { late: false });
    assert.match(message, /That was your last one/);
  });

  it("explains takes that earn nothing", () => {
    const late = blitzTakeMessage({ ...samTake, deadline: "2027-10-01" }, { points: 0, total: 4, left: 9, blocked: "late" }, { late: false });
    assert.equal(late.split("\n")[0], "🧾 #14 LOCKED · Sam");
    assert.match(late, /No blitz points: it's due after the 👑 is anointed/);
    const capped = blitzTakeMessage(samTake, { points: 0, total: 40, left: 0, blocked: "cap" }, { late: false });
    assert.match(capped, /No blitz points: you've used all 10/);
  });

  it("keeps the date check and the offline note", () => {
    const message = blitzTakeMessage({ ...samTake, dateAmbiguous: true }, { points: 4, total: 4, left: 9, blocked: null }, { late: true });
    assert.match(message, /@receipts cancel 14/);
    assert.match(message, /offline/);
  });

  it("closes the blitz with the board and the provisional crown", () => {
    const message = blitzOverMessage(results, times, url);
    assert.equal(message.split("\n")[0], "⏰ TAKE BLITZ OVER");
    assert.match(message, /1\. 👑 Sam: 18 pts \(5 takes\)/);
    assert.match(message, /2\. Dana: 6 pts \(3 takes\)/);
    assert.match(message, /The 👑 goes to Sam… for now\./);
    assert.match(message, /Oct 2, 2026 at 8:14pm/);
    assert.ok(message.endsWith(url));
  });

  it("closes an empty blitz without a crown", () => {
    const message = blitzOverMessage({ board: [], crown: [] }, times, url);
    assert.match(message, /Nobody made a single take/);
    assert.doesNotMatch(message, /for now/);
  });

  it("gives a last call with the unsettled takes", () => {
    const message = lastCallMessage(results, [4, 7, 12], times, url);
    assert.match(message, /Oct 2, 2026 at 8:14pm/);
    assert.match(message, /👑 Sam \(18 pts\)/);
    assert.match(message, /#4, #7, #12/);
    assert.match(message, /keep half/);
    assert.match(lastCallMessage(results, [], times, url), /Every blitz take is settled/);
  });

  it("anoints the winners with the final board", () => {
    const message = anointedMessage(results, url);
    assert.equal(message.split("\n")[0], "👑 THE CROWN IS ANOINTED");
    assert.match(message, /All hail Sam\./);
    assert.match(message, /1\. 👑 Sam: 18 pts/);
    const tie = anointedMessage({ board: results.board, crown: ["i:sam", "i:dana"] }, url);
    assert.match(tie, /All hail Sam & Dana\./);
    assert.match(anointedMessage({ board: [], crown: [] }, url), /Nobody/);
  });

  it("announces the crown changing hands", () => {
    assert.equal(crownChangeMessage(["Sam"], ["Sam"]), null);
    assert.equal(crownChangeMessage(["Sam", "Dana"], ["Dana", "Sam"]), null);
    assert.equal(crownChangeMessage([], []), null);
    assert.equal(crownChangeMessage([], ["Sam"]), "👑 Sam takes the crown.");
    assert.equal(crownChangeMessage(["Sam"], ["Dana"]), "👑 CROWN STOLEN. Dana takes it from Sam.");
    assert.equal(crownChangeMessage(["Sam"], ["Sam", "Dana"]), "👑 Dana ties Sam for the crown.");
    assert.equal(crownChangeMessage(["Sam"], ["Sam", "Dana", "Alex"]), "👑 Dana & Alex tie Sam for the crown.");
    assert.equal(crownChangeMessage(["Sam", "Dana"], ["Sam"]), "👑 Sam now holds the crown alone.");
    assert.equal(crownChangeMessage(["Sam"], []), "👑 Nobody holds the crown now.");
  });
});

describe("callout copy", () => {
  const exposed: ChatReceipt = {
    number: 14,
    type: "take",
    status: "pending",
    capture: "reply",
    subjectName: "Dana",
    statement: "No way the Knicks make the playoffs.",
    madeOn: "2024-03-04",
    deadline: null,
    dateAmbiguous: false,
    heat: null
  };
  const told: ChatReceipt = { ...exposed, number: 15, subjectName: "Sam", statement: "The Knicks make the playoffs" };

  it("exposes the old take in its author's exact words", () => {
    assert.deepEqual(exposedMessage(exposed, { exposerName: "Sam", blitz: null, late: false }).split("\n"), [
      "🚨 EXPOSED",
      "On Mar 4, 2024, Dana said:",
      '"No way the Knicks make the playoffs."',
      "",
      "Exposed by Sam · Receipt #14",
      'Was Dana wrong? Reply "@receipts 14 wrong" or "@receipts 14 right".'
    ]);
  });

  it("spells out what an exposé costs during the blitz", () => {
    const stake = (left: number, blocked: "cap" | null = null) =>
      exposedMessage(exposed, { exposerName: "Sam", blitz: { points: blocked ? 0 : 2, total: 0, left, blocked }, late: false }).split("\n").at(-1);
    assert.equal(stake(7), "If it was wrong, Dana loses 2 blitz points. Sam has 7 takes left.");
    assert.equal(stake(0), "If it was wrong, Dana loses 2 blitz points. That was Sam's last one.");
    assert.equal(stake(0, "cap"), "No blitz points: Sam has used all 10.");
  });

  it("puts a told-you-so up for the group to confirm", () => {
    assert.deepEqual(toldYouSoMessage(told, { blitz: null, late: false }).split("\n"), [
      "🧾 TOLD YOU SO",
      "On Mar 4, 2024, Sam said:",
      '"The Knicks make the playoffs"',
      "",
      'Receipt #15 · Was Sam right? Reply "@receipts 15 right" or "@receipts 15 wrong".'
    ]);
  });

  it("shows what a told-you-so is worth during the blitz", () => {
    const stake = (left: number, blocked: "cap" | null = null) =>
      toldYouSoMessage(told, { blitz: { points: blocked ? 0 : 2, total: 8, left, blocked }, late: false }).split("\n").at(-1);
    assert.equal(stake(7), "Sam +2 if it holds up · blitz total: 8 · 7 takes left");
    assert.equal(stake(0), "Sam +2 if it holds up · blitz total: 8 · That was your last one.");
    assert.equal(stake(0, "cap"), "No blitz points: you've used all 10.");
  });

  it("notes late processing", () => {
    assert.match(exposedMessage(exposed, { exposerName: "Sam", blitz: null, late: true }), /offline/);
    assert.match(toldYouSoMessage(told, { blitz: null, late: true }), /offline/);
  });
});
