// Temp checks for Take Blitz takes. TypeSafe's Jev model answers three Score questions about a take, and code turns
// its answers into the take's temperature, 0–100°. The questions, levels, and weights all live here so they're easy
// to review and tune. Pure: the server makes the HTTP call (server/jev.ts).

import type { IsoDate } from "./types";

/** TypeSafe's System One endpoint. */
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** TypeSafe's latest stable Jev. Pin a versioned id (e.g. "jev-1.13.0") once the weights are tuned against it. */
export const JEV_MODEL = "jev-latest";

/**
 * A take as Jev sees it. `due` is in words ("by the end of tomorrow"): Jev reads dates as text, so code works out
 * how far off the deadline is.
 */
export type TakeToGrade = { take: string; due: string };

/** Jev's read on a take. Each dimension runs from 0 (its lowest level) to 1 (its highest). */
export type TakeGrade = {
  /** How unlikely the take is to come true: 0 a sure thing, 1 a long shot. */
  boldness: number;
  /** How much friends would argue about it: 0 nobody pushes back, 1 the chat erupts. */
  spice: number;
  /** How cleanly it can be settled: 0 a matter of opinion, 1 clear-cut. */
  clarity: number;
};

export type GradeDimension = keyof TakeGrade;

/** Grade dimensions in label order. */
const DIMENSIONS: readonly GradeDimension[] = ["boldness", "spice", "clarity"];

const DAY = 24 * 60 * 60 * 1000;

type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };

/** Request body for TypeSafe's System One endpoint. */
export type TakeGradeRequest = {
  model: string;
  state: TakeToGrade;
  questions: Record<GradeDimension, ScoreQuestion>;
};

/**
 * One Score question per dimension, asked together in one request. Levels run low to high and describe situations,
 * since Jev judges each level on its own without seeing its number or its neighbors.
 */
export const TAKE_GRADE_QUESTIONS: Record<GradeDimension, ScoreQuestion> = {
  boldness: {
    type: "score",
    instructions: "How bold a prediction is `take`, given that it has to come true `due`?",
    criteria: [
      "A sure thing: it would be strange if it didn't come true",
      "Likely: most people would expect it to come true",
      "A toss-up: it could easily go either way",
      "Unlikely: most people would bet against it",
      "A long shot: people would be shocked if it came true"
    ]
  },
  spice: {
    type: "score",
    instructions: "How much would a group of friends argue about `take` when they first hear it?",
    criteria: [
      "Nobody would push back on it",
      "A few people might question it",
      "It would start a real debate",
      "The group chat would erupt"
    ]
  },
  clarity: {
    type: "score",
    instructions: "Once `due` arrives, how clearly could a group of friends agree on whether `take` came true?",
    criteria: [
      "Impossible to settle: a matter of opinion or taste, or too vague to check",
      "Hard to settle: friends could reasonably argue about whether it happened",
      "Mostly settleable: a checkable outcome with a little wiggle room",
      "Clear-cut: a specific outcome anyone could check"
    ]
  }
};

/** Short chat labels for each level of each question, in the same order as its criteria. */
export const GRADE_LABELS: Record<GradeDimension, readonly string[]> = {
  boldness: ["sure thing", "likely", "toss-up", "unlikely", "long shot"],
  spice: ["no debate", "mild", "spicy", "inferno"],
  clarity: ["unsettleable", "arguable", "settleable", "clear-cut"]
};

/** How much boldness and spice each count toward a take's temperature. They add up to 1. */
export const TEMP_WEIGHTS = { boldness: 0.7, spice: 0.3 } as const;

/** Share of its temperature a take keeps when nobody could settle it. Clear-cut takes keep all of it. */
export const UNSETTLEABLE_SHARE = 0.5;

/** How far off `deadline` is from `today`, in words: "by the end of tomorrow", "within 3 weeks". */
export function dueInWords(deadline: IsoDate, today: IsoDate): string {
  const days = Math.round((Date.parse(deadline) - Date.parse(today)) / DAY);
  if (days <= 0) return "by the end of today";
  if (days === 1) return "by the end of tomorrow";
  if (days < 14) return `within ${days} days`;
  if (days < 60) return `within ${Math.round(days / 7)} weeks`;
  if (days < 730) return `within ${Math.round(days / 30)} months`;
  return `within ${Math.round(days / 365)} years`;
}

/** The System One request that grades one take. */
export function takeGradeRequest(take: TakeToGrade, model: string = JEV_MODEL): TakeGradeRequest {
  return { model, state: take, questions: TAKE_GRADE_QUESTIONS };
}

/**
 * Reads the grade out of a System One response, or null when any answer is missing or malformed.
 * `model` is the versioned id that answered.
 */
export function parseTakeGrade(body: unknown): { grade: TakeGrade; model: string } | null {
  if (!isRecord(body) || !isRecord(body.answers)) {
    return null;
  }
  const grade: Partial<TakeGrade> = {};
  for (const dimension of DIMENSIONS) {
    const answer = body.answers[dimension];
    const top = TAKE_GRADE_QUESTIONS[dimension].criteria.length - 1;
    if (!isRecord(answer) || answer.type !== "score" || typeof answer.score !== "number") {
      return null;
    }
    if (!(answer.score >= 0 && answer.score <= top)) {
      return null;
    }
    grade[dimension] = Math.round((answer.score / top) * 100) / 100;
  }
  return { grade: grade as TakeGrade, model: typeof body.model === "string" ? body.model : JEV_MODEL };
}

/**
 * The take's temperature for its temp check, 0–100°: boldness and spice by TEMP_WEIGHTS, scaled by clarity from
 * UNSETTLEABLE_SHARE (can't be settled) to all of it (clear-cut). A clear-cut long shot that sets off the chat is
 * 100°.
 */
export function takeTemp(grade: TakeGrade): number {
  const heat = TEMP_WEIGHTS.boldness * grade.boldness + TEMP_WEIGHTS.spice * grade.spice;
  const settleable = UNSETTLEABLE_SHARE + (1 - UNSETTLEABLE_SHARE) * grade.clarity;
  return Math.round(100 * heat * settleable);
}

/** Chat labels for a grade, each dimension's nearest level: ["long shot", "spicy", "clear-cut"]. */
export function gradeLabels(grade: TakeGrade): string[] {
  return DIMENSIONS.map((dimension) => {
    const labels = GRADE_LABELS[dimension];
    return labels[Math.round(grade[dimension] * (labels.length - 1))];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
