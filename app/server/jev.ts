// Grades Take Blitz takes with TypeSafe's Jev over HTTP for their temp checks. The questions and scoring live in
// shared/jev.ts.

import type { LogContext } from "lakebed/server";
import { parseTakeGrade, takeGradeRequest, takeTemp, TYPESAFE_URL, type TakeGrade, type TakeToGrade } from "../shared/jev";

/** Grades a take, or resolves null when Jev can't. Grading never keeps a take from being logged. */
export type TakeGrader = (take: TakeToGrade) => Promise<TakeGrade | null>;

/**
 * How long a take waits on Jev before it's logged without a grade. The bot endpoint's transaction gets 5 seconds in
 * all, so this leaves room for the rest of the handler.
 */
export const JEV_TIMEOUT_MS = 2500;

/** A grader backed by TypeSafe's API, or undefined without an API key. */
export function jevGrader(apiKey: string | undefined, log: LogContext, options: { timeoutMs?: number } = {}): TakeGrader | undefined {
  const key = apiKey?.trim();
  if (!key) {
    return undefined;
  }
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  return async (take) => {
    try {
      // No retries: a rate-limited or overloaded Jev just means this take goes ungraded.
      const response = await fetch(TYPESAFE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(takeGradeRequest(take)),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        log.warn("jev grade failed", { status: response.status });
        return null;
      }
      const parsed = parseTakeGrade(await response.json());
      if (!parsed) {
        log.warn("jev grade unreadable", { status: response.status });
        return null;
      }
      log.info("jev grade", { model: parsed.model, temp: takeTemp(parsed.grade) });
      return parsed.grade;
    } catch (error) {
      log.warn("jev grade failed", { error: error instanceof Error ? error.name : String(error) });
      return null;
    }
  };
}
