import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, dueAtFor, dueAtFrom, findDeadline, formatDate, formatDateTime, formatTime, isIsoDate, localDate } from "../../app/shared/dates";

// Friday, Sep 25 2026.
const TODAY = "2026-09-25";

function deadline(text: string, today = TODAY) {
  const match = findDeadline(text, today);
  return match ? { date: match.date, ambiguous: match.ambiguous, phrase: text.slice(match.start, match.end) } : null;
}

describe("isIsoDate", () => {
  it("accepts real calendar dates only", () => {
    assert.equal(isIsoDate("2027-10-01"), true);
    assert.equal(isIsoDate("2024-02-29"), true);
    assert.equal(isIsoDate("2027-02-29"), false);
    assert.equal(isIsoDate("2027-02-30"), false);
    assert.equal(isIsoDate("2027-1-1"), false);
    assert.equal(isIsoDate("2027-13-01"), false);
    assert.equal(isIsoDate(20271001), false);
    assert.equal(isIsoDate(null), false);
  });
});

describe("localDate", () => {
  it("applies the UTC offset", () => {
    assert.equal(localDate(Date.UTC(2026, 8, 26, 5, 0), -420), "2026-09-25");
    assert.equal(localDate(Date.UTC(2026, 8, 26, 8, 0), -420), "2026-09-26");
    assert.equal(localDate(Date.UTC(2026, 8, 25, 23, 30), 60), "2026-09-26");
  });
});

describe("dueAtFor", () => {
  it("is 10:00 local time on the deadline date", () => {
    assert.equal(dueAtFor("2027-10-01", -420), Date.UTC(2027, 9, 1, 17, 0));
    assert.equal(dueAtFor("2027-10-01", 0), Date.UTC(2027, 9, 1, 10, 0));
  });
});

describe("addDays", () => {
  it("crosses month, year, and leap boundaries", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2024-02-28", 1), "2024-02-29");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-09-25", 14), "2026-10-09");
  });
});

describe("formatDate", () => {
  it("uses short month names", () => {
    assert.equal(formatDate("2027-10-01"), "Oct 1, 2027");
    assert.equal(formatDate("2026-12-25"), "Dec 25, 2026");
  });
});

describe("findDeadline", () => {
  it("reads month-day-year phrases and reports the phrase range", () => {
    assert.deepEqual(deadline("the Giants win the division by Oct 1 2027"), {
      date: "2027-10-01",
      ambiguous: false,
      phrase: "by Oct 1 2027"
    });
    assert.deepEqual(deadline("Warriors win 60 games by April 12 2027"), {
      date: "2027-04-12",
      ambiguous: false,
      phrase: "by April 12 2027"
    });
    assert.equal(deadline("done by October 1st, 2027")?.date, "2027-10-01");
    assert.equal(deadline("done by 1 Oct 2027")?.date, "2027-10-01");
    assert.equal(deadline("done by Sept. 3, 2027")?.date, "2027-09-03");
  });

  it("infers the next occurrence when the year is missing and marks it ambiguous", () => {
    assert.deepEqual(deadline("by Dec 1"), { date: "2026-12-01", ambiguous: true, phrase: "by Dec 1" });
    assert.deepEqual(deadline("by Jun 1"), { date: "2027-06-01", ambiguous: true, phrase: "by Jun 1" });
    assert.deepEqual(deadline("by Oct. 1"), { date: "2026-10-01", ambiguous: true, phrase: "by Oct. 1" });
    assert.equal(deadline("on Sep 25")?.date, "2026-09-25");
  });

  it("reads numeric dates as month/day", () => {
    assert.deepEqual(deadline("on 12/31"), { date: "2026-12-31", ambiguous: true, phrase: "on 12/31" });
    assert.deepEqual(deadline("by 12/31/2027"), { date: "2027-12-31", ambiguous: false, phrase: "by 12/31/2027" });
    assert.equal(deadline("by 1/5/27")?.date, "2027-01-05");
    assert.deepEqual(deadline("before 2027-03-15"), { date: "2027-03-15", ambiguous: false, phrase: "before 2027-03-15" });
  });

  it("reads month-level phrases", () => {
    assert.deepEqual(deadline("iPhone Fold before September 2027"), {
      date: "2027-09-01",
      ambiguous: false,
      phrase: "before September 2027"
    });
    assert.deepEqual(deadline("iPhone Fold by September 2027"), {
      date: "2027-09-30",
      ambiguous: true,
      phrase: "by September 2027"
    });
    assert.deepEqual(deadline("by end of February 2028"), { date: "2028-02-29", ambiguous: false, phrase: "by end of February 2028" });
    assert.deepEqual(deadline("by March"), { date: "2027-03-31", ambiguous: true, phrase: "by March" });
    assert.deepEqual(deadline("before June"), { date: "2027-06-01", ambiguous: true, phrase: "before June" });
  });

  it("reads year-level phrases", () => {
    assert.deepEqual(deadline("OpenAI will IPO before 2028"), { date: "2028-01-01", ambiguous: false, phrase: "before 2028" });
    assert.deepEqual(deadline("OpenAI will IPO by 2028"), { date: "2028-12-31", ambiguous: true, phrase: "by 2028" });
    assert.deepEqual(deadline("done by the end of 2027"), { date: "2027-12-31", ambiguous: false, phrase: "by the end of 2027" });
  });

  it("reads relative phrases", () => {
    assert.deepEqual(deadline("by tomorrow"), { date: "2026-09-26", ambiguous: false, phrase: "by tomorrow" });
    assert.deepEqual(deadline("in 2 weeks"), { date: "2026-10-09", ambiguous: false, phrase: "in 2 weeks" });
    assert.deepEqual(deadline("within 10 days"), { date: "2026-10-05", ambiguous: false, phrase: "within 10 days" });
    assert.equal(deadline("in three months")?.date, "2026-12-25");
    assert.equal(deadline("within a year")?.date, "2027-09-25");
    assert.deepEqual(deadline("by Friday"), { date: "2026-10-02", ambiguous: true, phrase: "by Friday" });
    assert.equal(deadline("by Monday")?.date, "2026-09-28");
    assert.deepEqual(deadline("by end of the month"), { date: "2026-09-30", ambiguous: false, phrase: "by end of the month" });
    assert.deepEqual(deadline("by EOY"), { date: "2026-12-31", ambiguous: false, phrase: "by EOY" });
    assert.equal(deadline("by the end of the year")?.date, "2026-12-31");
    assert.equal(deadline("by next week")?.date, "2026-10-02");
    assert.equal(deadline("by next week")?.ambiguous, true);
    assert.equal(deadline("by christmas")?.date, "2026-12-25");
  });

  it("marks explicit past dates ambiguous", () => {
    assert.deepEqual(deadline("by Oct 1 2020"), { date: "2020-10-01", ambiguous: true, phrase: "by Oct 1 2020" });
  });

  it("returns the last deadline phrase", () => {
    assert.equal(deadline("if X happens by Dec 1, JR admits Y by Jan 5 2027")?.date, "2027-01-05");
  });

  it("ignores text without dates", () => {
    assert.equal(deadline("by the All-Star break"), null);
    assert.equal(deadline("Kuminga averages 20 PPG"), null);
    assert.equal(deadline("the Warriors may win 60 games"), null);
    assert.equal(deadline("Niners go 12-5"), null);
    assert.equal(deadline("by Feb 30 2027"), null);
    assert.equal(deadline("Nvidia is below $150"), null);
  });
});

describe("dueAtFrom", () => {
  // 8pm and 9am PDT on Friday, Sep 25 2026.
  const evening = Date.UTC(2026, 8, 26, 3, 0);
  const morning = Date.UTC(2026, 8, 25, 16, 0);

  it("makes a same-day deadline due the next morning once its due time has passed", () => {
    assert.equal(dueAtFrom("2026-09-25", -420, evening), dueAtFor("2026-09-26", -420));
  });

  it("keeps a same-day deadline that is not due yet", () => {
    assert.equal(dueAtFrom("2026-09-25", -420, morning), dueAtFor("2026-09-25", -420));
  });

  it("leaves future and past deadlines alone", () => {
    assert.equal(dueAtFrom("2026-10-01", -420, evening), dueAtFor("2026-10-01", -420));
    assert.equal(dueAtFrom("2026-09-20", -420, evening), dueAtFor("2026-09-20", -420));
  });
});

describe("formatTime and formatDateTime", () => {
  it("shows local 12-hour times", () => {
    assert.equal(formatTime(Date.UTC(2026, 8, 26, 3, 14), -420), "8:14pm");
    assert.equal(formatTime(Date.UTC(2026, 8, 25, 7, 5), -420), "12:05am");
    assert.equal(formatTime(Date.UTC(2026, 8, 25, 19, 0), -420), "12:00pm");
    assert.equal(formatTime(Date.UTC(2026, 8, 25, 16, 3), -420), "9:03am");
  });

  it("shows the local date with the time", () => {
    assert.equal(formatDateTime(Date.UTC(2026, 9, 3, 3, 14), -420), "Oct 2, 2026 at 8:14pm");
  });
});
