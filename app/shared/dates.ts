// Calendar-date helpers and forgiving deadline extraction.
// Dates are ISO calendar strings ("2027-10-01"); instants are epoch ms.

import type { IsoDate } from "./types";

/** Local hour at which a deadline day becomes due, so reminders do not land at midnight. */
export const DUE_HOUR = 10;

export type DeadlineMatch = {
  date: IsoDate;
  /** True when the date was guessed (missing year, month-only, weekday, etc.) and must be confirmed. */
  ambiguous: boolean;
  /** Character range of the deadline phrase (including a leading "by"/"before"/"on") in the input. */
  start: number;
  end: number;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};

type Ymd = { year: number; month: number; day: number };

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const { year, month, day } = splitDate(value);
  return isValidYmd(year, month, day);
}

/** Local calendar date of an instant, given the UTC offset in minutes (e.g. -420 for PDT). */
export function localDate(instant: number, utcOffsetMinutes: number): IsoDate {
  return new Date(instant + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Epoch ms at which a deadline date becomes due: DUE_HOUR local time on that date. */
export function dueAtFor(date: IsoDate, utcOffsetMinutes: number): number {
  const { year, month, day } = splitDate(date);
  return Date.UTC(year, month - 1, day, DUE_HOUR) - utcOffsetMinutes * 60_000;
}

/**
 * When a deadline logged at `madeAt` comes due. Like `dueAtFor`, except a deadline on the day it was made ("tonight")
 * that would already be due comes due the next morning instead of immediately.
 */
export function dueAtFrom(date: IsoDate, utcOffsetMinutes: number, madeAt: number): number {
  const dueAt = dueAtFor(date, utcOffsetMinutes);
  if (dueAt <= madeAt && date === localDate(madeAt, utcOffsetMinutes)) {
    return dueAtFor(addDays(date, 1), utcOffsetMinutes);
  }
  return dueAt;
}

/** Local time of day of an instant: "8:14pm", "12:05am". */
export function formatTime(instant: number, utcOffsetMinutes: number): string {
  const local = new Date(instant + utcOffsetMinutes * 60_000);
  const hours = local.getUTCHours();
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  return `${hours % 12 || 12}:${minutes}${hours < 12 ? "am" : "pm"}`;
}

/** Local date and time of an instant: "Oct 2, 2026 at 8:14pm". */
export function formatDateTime(instant: number, utcOffsetMinutes: number): string {
  return `${formatDate(localDate(instant, utcOffsetMinutes))} at ${formatTime(instant, utcOffsetMinutes)}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = splitDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** "2027-10-01" → "Oct 1, 2027". */
export function formatDate(date: IsoDate): string {
  const { year, month, day } = splitDate(date);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

/**
 * Finds the deadline phrase in free text, relative to `today`.
 * Returns the last deadline-looking phrase, or null when there is none.
 */
export function findDeadline(text: string, today: IsoDate): DeadlineMatch | null {
  const now = splitDate(today);
  let best: DeadlineMatch | null = null;

  for (const { pattern, resolve } of RULES) {
    for (const match of text.matchAll(pattern)) {
      const groups = match.groups ?? {};
      const resolved = resolve(groups, now);
      if (!resolved) continue;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const date = toIso(resolved.date);
      const candidate: DeadlineMatch = { date, ambiguous: resolved.ambiguous || date < today, start, end };
      if (!best || end > best.end || (end === best.end && start < best.start)) {
        best = candidate;
      }
    }
  }
  return best;
}

// --- Rules -----------------------------------------------------------------

type Resolved = { date: Ymd; ambiguous: boolean } | null;
type Rule = { pattern: RegExp; resolve: (groups: Record<string, string | undefined>, today: Ymd) => Resolved };

const PREP = String.raw`(?:\b(?<prep>by|before|on|until|till|til|in|within|due|come)\s+)?`;
const MONTH = String.raw`(?<month>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const ORDINAL = String.raw`(?:st|nd|rd|th)?`;

function rule(source: string, resolve: Rule["resolve"]): Rule {
  return { pattern: new RegExp(source, "gi"), resolve };
}

const RULES: Rule[] = [
  // 2027-03-15
  rule(String.raw`${PREP}\b(?<year>\d{4})-(?<m>\d{2})-(?<d>\d{2})\b`, (g) =>
    exact(Number(g.year), Number(g.m), Number(g.d))
  ),

  // 12/31, 12/31/2027, 1/5/27
  rule(String.raw`${PREP}\b(?<m>\d{1,2})\/(?<d>\d{1,2})(?:\/(?<year>\d{4}|\d{2}))?\b(?!\/)`, (g, today) =>
    monthDay(Number(g.m), Number(g.d), g.year, today)
  ),

  // Oct 1, October 1st 2027, Sept. 3, 2027
  rule(String.raw`${PREP}\b${MONTH}\s+(?<d>\d{1,2})${ORDINAL}\b(?:,?\s+(?<year>\d{4})\b)?`, (g, today) =>
    monthDay(monthIndex(g.month), Number(g.d), g.year, today)
  ),

  // 1 Oct 2027, 1st of October
  rule(String.raw`${PREP}\b(?<d>\d{1,2})${ORDINAL}\s+(?:of\s+)?${MONTH}(?:,?\s+(?<year>\d{4})\b)?`, (g, today) =>
    monthDay(monthIndex(g.month), Number(g.d), g.year, today)
  ),

  // end of February 2028
  rule(String.raw`${PREP}(?:the\s+)?\bend\s+of\s+${MONTH}(?:,?\s+(?<year>\d{4})\b)?`, (g, today) => {
    const month = monthIndex(g.month);
    if (g.year) return { date: lastDayOf(Number(g.year), month), ambiguous: false };
    return { date: nextMonthOccurrence(month, today, "last"), ambiguous: true };
  }),

  // September 2027
  rule(String.raw`${PREP}\b${MONTH},?\s+(?<year>\d{4})\b`, (g) => {
    const month = monthIndex(g.month);
    const year = Number(g.year);
    const prep = g.prep?.toLowerCase();
    if (prep === "before") return { date: { year, month, day: 1 }, ambiguous: false };
    return { date: lastDayOf(year, month), ambiguous: prep !== "in" };
  }),

  // by March, before June (month without day or year needs a preposition)
  rule(String.raw`\b(?<prep>by|before|in|until|till)\s+${MONTH}(?![\s.,]*\d)`, (g, today) => {
    const month = monthIndex(g.month);
    const edge = g.prep?.toLowerCase() === "before" ? "first" : "last";
    return { date: nextMonthOccurrence(month, today, edge), ambiguous: true };
  }),

  // before 2028, by 2028, by the end of 2027
  rule(String.raw`\b(?:(?<prep>by|before|in|until|till|during)\s+)?(?:the\s+)?(?<endof>end\s+of\s+)?(?<year>20\d{2})\b(?![\/-]\d)`, (g) => {
    const year = Number(g.year);
    const prep = g.prep?.toLowerCase();
    if (!prep && !g.endof) return null;
    if (g.endof) return { date: { year, month: 12, day: 31 }, ambiguous: false };
    if (prep === "before") return { date: { year, month: 1, day: 1 }, ambiguous: false };
    return { date: { year, month: 12, day: 31 }, ambiguous: prep !== "in" && prep !== "during" };
  }),

  // today, tonight, tomorrow
  rule(String.raw`${PREP}\b(?<word>today|tonight|tomorrow|tmrw)\b`, (g, today) => ({
    date: addDaysYmd(today, /^(today|tonight)$/i.test(g.word ?? "") ? 0 : 1),
    ambiguous: false
  })),

  // in 2 weeks, within a year
  rule(
    String.raw`\b(?<prep>in|within)\s+(?<count>\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?<unit>day|week|month|year)s?\b`,
    (g, today) => {
      const raw = g.count?.toLowerCase() ?? "";
      const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
      if (!count) return null;
      const unit = g.unit?.toLowerCase();
      if (unit === "day") return { date: addDaysYmd(today, count), ambiguous: false };
      if (unit === "week") return { date: addDaysYmd(today, count * 7), ambiguous: false };
      if (unit === "month") return { date: addMonthsYmd(today, count), ambiguous: false };
      return { date: addMonthsYmd(today, count * 12), ambiguous: false };
    }
  ),

  // by Friday, next Friday
  rule(String.raw`${PREP}(?:(?:next|this)\s+)?\b(?<weekday>sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b`, (g, today) => {
    const target = WEEKDAYS.indexOf(g.weekday?.toLowerCase() ?? "");
    const current = weekday(today);
    const delta = ((target - current + 7) % 7) || 7;
    return { date: addDaysYmd(today, delta), ambiguous: true };
  }),

  // end of the week/month/year, EOY
  rule(String.raw`${PREP}(?:(?:the\s+)?\bend\s+of\s+(?:the\s+)?(?<unit>week|month|year)\b|\b(?<short>eow|eom|eoy)\b)`, (g, today) => {
    const unit = g.unit?.toLowerCase() ?? { eow: "week", eom: "month", eoy: "year" }[g.short?.toLowerCase() ?? ""];
    if (unit === "week") return { date: addDaysYmd(today, (7 - weekday(today)) % 7), ambiguous: false };
    if (unit === "month") return { date: lastDayOf(today.year, today.month), ambiguous: false };
    return { date: { year: today.year, month: 12, day: 31 }, ambiguous: false };
  }),

  // next week/month/year
  rule(String.raw`${PREP}\bnext\s+(?<unit>week|month|year)\b`, (g, today) => {
    const unit = g.unit?.toLowerCase();
    if (unit === "week") return { date: addDaysYmd(today, 7), ambiguous: true };
    if (unit === "month") {
      const next = addMonthsYmd({ ...today, day: 1 }, 1);
      return { date: lastDayOf(next.year, next.month), ambiguous: true };
    }
    return { date: { year: today.year + 1, month: 12, day: 31 }, ambiguous: true };
  }),

  // Christmas, New Year's, Halloween
  rule(String.raw`${PREP}\b(?<holiday>christmas|xmas|new\s+year'?s(?:\s+eve)?|halloween)\b`, (g, today) => {
    const holiday = g.holiday?.toLowerCase().replace(/\s+/g, " ") ?? "";
    if (holiday.endsWith("eve")) return { date: nextDayOccurrence(12, 31, today), ambiguous: false };
    if (holiday.startsWith("new year")) return { date: nextDayOccurrence(1, 1, today), ambiguous: false };
    if (holiday === "halloween") return { date: nextDayOccurrence(10, 31, today), ambiguous: false };
    return { date: nextDayOccurrence(12, 25, today), ambiguous: false };
  })
];

// --- Helpers ---------------------------------------------------------------

function splitDate(date: IsoDate): Ymd {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function toIso({ year, month, day }: Ymd): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function lastDayOf(year: number, month: number): Ymd {
  return { year, month, day: daysInMonth(year, month) };
}

function monthIndex(name: string | undefined): number {
  const prefix = (name ?? "").slice(0, 3).toLowerCase();
  return MONTH_NAMES.findIndex((month) => month.toLowerCase() === prefix) + 1;
}

function weekday(date: Ymd): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDaysYmd(date: Ymd, days: number): Ymd {
  return splitDate(addDays(toIso(date), days));
}

function addMonthsYmd(date: Ymd, months: number): Ymd {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

function compare(a: Ymd, b: Ymd): number {
  return toIso(a) < toIso(b) ? -1 : toIso(a) > toIso(b) ? 1 : 0;
}

function exact(year: number, month: number, day: number): Resolved {
  return isValidYmd(year, month, day) ? { date: { year, month, day }, ambiguous: false } : null;
}

function monthDay(month: number, day: number, rawYear: string | undefined, today: Ymd): Resolved {
  if (month < 1 || month > 12) return null;
  if (rawYear) {
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return exact(year, month, day);
  }
  if (!isValidYmd(2024, month, day)) return null;
  return { date: nextDayOccurrence(month, day, today), ambiguous: true };
}

/** The first date on or after today with this month and day. */
function nextDayOccurrence(month: number, day: number, today: Ymd): Ymd {
  for (let year = today.year; year < today.year + 8; year += 1) {
    if (isValidYmd(year, month, day) && compare({ year, month, day }, today) >= 0) {
      return { year, month, day };
    }
  }
  return { year: today.year + 1, month, day };
}

/** First or last day of the next occurrence of `month` that is not in the past. */
function nextMonthOccurrence(month: number, today: Ymd, edge: "first" | "last"): Ymd {
  const make = (year: number) => (edge === "first" ? { year, month, day: 1 } : lastDayOf(year, month));
  const thisYear = make(today.year);
  return compare(thisYear, today) >= 0 ? thisYear : make(today.year + 1);
}
