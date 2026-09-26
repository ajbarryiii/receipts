// Heat and Take Score rules.

import { OFFICIAL_STATUSES, type ReceiptStatus, type ReceiptType, type Standing, type SubjectRef } from "./types";

/** Points for a correct take, by official heat. */
export const TAKE_POINTS: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 12 };

/** Correct takes nobody rated before settlement score as one flame. */
export const UNRATED_TAKE_POINTS = 1;

export function isFlameRating(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Official heat from individual votes: the median, rounded half up. Null without votes. */
export function medianHeat(votes: readonly number[]): number | null {
  if (votes.length === 0) {
    return null;
  }
  const sorted = [...votes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(median);
}

/** Take Score points a receipt earns. Only settled-right takes earn points; wrong takes earn 0 for now. */
export function takePoints(receipt: { type: ReceiptType; status: ReceiptStatus; heat: number | null }): number {
  if (receipt.type !== "take" || receipt.status !== "right") {
    return 0;
  }
  return receipt.heat === null ? UNRATED_TAKE_POINTS : (TAKE_POINTS[receipt.heat] ?? UNRATED_TAKE_POINTS);
}

export type ScoredReceipt = {
  subjectRef: SubjectRef;
  subjectName: string;
  type: ReceiptType;
  status: ReceiptStatus;
  heat: number | null;
};

type Tally = Standing & { heatTotal: number; heatCount: number };

/**
 * Group standings, one row per subject with at least one take.
 * Sorted by Take Score, then right calls, then name.
 * `names` overrides display names per subject (e.g. linked account names).
 */
export function computeStandings(receipts: readonly ScoredReceipt[], names?: ReadonlyMap<SubjectRef, string>): Standing[] {
  const tallies = new Map<SubjectRef, Tally>();
  for (const receipt of receipts) {
    if (!countsTowardStandings(receipt)) {
      continue;
    }
    let tally = tallies.get(receipt.subjectRef);
    if (!tally) {
      tally = emptyTally(receipt.subjectRef, names?.get(receipt.subjectRef) ?? receipt.subjectName);
      tallies.set(receipt.subjectRef, tally);
    }
    addToTally(tally, receipt);
  }
  return [...tallies.values()].map(finishTally).sort(
    (a, b) => b.takeScore - a.takeScore || b.right - a.right || a.name.localeCompare(b.name)
  );
}

/** The standing for one subject, with zeroes when they have no takes. */
export function standingFor(subjectRef: SubjectRef, name: string, receipts: readonly ScoredReceipt[]): Standing {
  const tally = emptyTally(subjectRef, name);
  for (const receipt of receipts) {
    if (receipt.subjectRef === subjectRef && countsTowardStandings(receipt)) {
      addToTally(tally, receipt);
    }
  }
  return finishTally(tally);
}

/** Only official takes count: nominations, rejections, and cancellations never do. */
function countsTowardStandings(receipt: ScoredReceipt): boolean {
  return receipt.type === "take" && OFFICIAL_STATUSES.includes(receipt.status);
}

function emptyTally(subjectRef: SubjectRef, name: string): Tally {
  return { subjectRef, name, takeScore: 0, right: 0, wrong: 0, pending: 0, accuracy: null, averageHeat: null, heatTotal: 0, heatCount: 0 };
}

function addToTally(tally: Tally, receipt: ScoredReceipt): void {
  tally.takeScore += takePoints(receipt);
  if (receipt.status === "right") tally.right += 1;
  if (receipt.status === "wrong") tally.wrong += 1;
  if (receipt.status === "pending") tally.pending += 1;
  if (receipt.status !== "void" && receipt.heat !== null) {
    tally.heatTotal += receipt.heat;
    tally.heatCount += 1;
  }
}

function finishTally({ heatTotal, heatCount, ...standing }: Tally): Standing {
  const decided = standing.right + standing.wrong;
  return {
    ...standing,
    accuracy: decided > 0 ? standing.right / decided : null,
    averageHeat: heatCount > 0 ? heatTotal / heatCount : null
  };
}
