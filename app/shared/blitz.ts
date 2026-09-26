// Take Blitz rules: a one-time, 24-hour window after "@receipts lfg" where takes earn blitz points,
// and a 👑 for whoever holds the most points when it's anointed a week after the blitz started.

import { addDays, localDate } from "./dates";
import type { BlitzPhase, BlitzStanding, IsoDate, ReceiptStatus, SettlementOutcome, SubjectRef } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Takes sent this long after "@receipts lfg" earn blitz points. */
export const BLITZ_WINDOW_MS = 24 * HOUR;
/** The last-call message goes out this long after the blitz started, a day before the anointing. */
export const BLITZ_LAST_CALL_MS = 6 * DAY;
/** The 👑 is anointed this long after the blitz started. */
export const BLITZ_ANOINT_MS = 7 * DAY;
/** Blitz takes per person that earn points. Takes past the cap are still logged, for nothing. */
export const BLITZ_TAKE_CAP = 10;
/** Points for a blitz take due today or tomorrow. */
export const LIGHTNING_POINTS = 4;
/** Points for a blitz take due before the 👑 is anointed. */
export const WEEK_POINTS = 2;
/** Points at stake on an old take called out during the blitz ("exposed" or "told you so"). No timing bonus. */
export const CALLOUT_POINTS = 2;

export type BlitzSchedule = {
  startedAt: number;
  endsAt: number;
  lastCallAt: number;
  anointAt: number;
};

/** One blitz take, as the board needs it. */
export type BlitzEntry = {
  subjectRef: SubjectRef;
  name: string;
  status: ReceiptStatus;
  /** Points the take earned when it was logged. */
  points: number;
  /** Points it keeps, fixed when it was settled before the anointing. Null while unsettled. */
  kept: number | null;
  /**
   * An exposé: it costs its author `points` when settled wrong and never earns anything.
   * It isn't one of the author's takes, and an unsettled exposé costs nothing.
   */
  exposed: boolean;
};

export function blitzSchedule(startedAt: number): BlitzSchedule {
  return {
    startedAt,
    endsAt: startedAt + BLITZ_WINDOW_MS,
    lastCallAt: startedAt + BLITZ_LAST_CALL_MS,
    anointAt: startedAt + BLITZ_ANOINT_MS
  };
}

export function blitzPhase(schedule: BlitzSchedule, now: number): BlitzPhase {
  if (now < schedule.endsAt) return "live";
  return now < schedule.anointAt ? "provisional" : "final";
}

/**
 * Points a take logged on `today` earns: LIGHTNING_POINTS when due today or tomorrow, WEEK_POINTS when it comes due
 * before the anointing, and 0 otherwise (including deadlines already in the past).
 */
export function blitzPoints(take: { deadline: IsoDate; dueAt: number }, today: IsoDate, schedule: BlitzSchedule): number {
  if (take.deadline < today) return 0;
  if (take.deadline <= addDays(today, 1)) return LIGHTNING_POINTS;
  return take.dueAt < schedule.anointAt ? WEEK_POINTS : 0;
}

/** Deadline for an undated blitz take: the day before the anointing, local to the group. */
export function defaultBlitzDeadline(schedule: BlitzSchedule, utcOffsetMinutes: number): IsoDate {
  return addDays(localDate(schedule.anointAt, utcOffsetMinutes), -1);
}

/**
 * Points a blitz take keeps once settled: all of them when right, half when wrong, none when void.
 * An exposé keeps `-points` when wrong and 0 otherwise.
 */
export function keptPoints(points: number, outcome: SettlementOutcome, exposed = false): number {
  if (exposed) return outcome === "wrong" ? -points : 0;
  if (outcome === "right") return points;
  return outcome === "wrong" ? points / 2 : 0;
}

/**
 * Blitz scores per person, highest total first (then more takes, then name).
 * Canceled takes don't count. Unsettled takes ride on the tab at full value until the anointing, then keep half.
 * Exposés only count once settled, against their author.
 */
export function blitzBoard(entries: readonly BlitzEntry[], phase: BlitzPhase): BlitzStanding[] {
  const board = new Map<SubjectRef, BlitzStanding>();
  for (const entry of entries) {
    if (entry.status === "canceled") continue;
    const standing = board.get(entry.subjectRef) ?? { subjectRef: entry.subjectRef, name: entry.name, takes: 0, banked: 0, tab: 0, total: 0 };
    standing.name = entry.name;
    if (!entry.exposed) {
      standing.takes += 1;
    }
    if (entry.kept !== null) {
      standing.banked += entry.kept;
    } else if (entry.exposed) {
      // Unproven exposés cost nothing.
    } else if (phase === "final") {
      standing.banked += entry.points / 2;
    } else {
      standing.tab += entry.points;
    }
    standing.total = standing.banked + standing.tab;
    board.set(entry.subjectRef, standing);
  }
  return [...board.values()].sort((a, b) => b.total - a.total || b.takes - a.takes || a.name.localeCompare(b.name));
}

/** Who wears the 👑: nobody while the blitz is live or when nobody has a point, otherwise everyone tied for first. */
export function crownHolders(board: readonly BlitzStanding[], phase: BlitzPhase): SubjectRef[] {
  if (phase === "live") return [];
  const best = Math.max(0, ...board.map((standing) => standing.total));
  return best > 0 ? board.filter((standing) => standing.total === best).map((standing) => standing.subjectRef) : [];
}
