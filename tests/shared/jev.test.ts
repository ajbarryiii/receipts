import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dueInWords,
  GRADE_LABELS,
  gradeLabels,
  JEV_MODEL,
  parseTakeGrade,
  TAKE_GRADE_QUESTIONS,
  takeGradeRequest,
  takeTemp,
  TEMP_WEIGHTS,
  type GradeDimension,
  type TakeGrade
} from "../../app/shared/jev";

const TODAY = "2026-09-25";
const DIMENSIONS: GradeDimension[] = ["boldness", "spice", "clarity"];

/** A Score answer as TypeSafe returns it, placed at `score` on `levels` levels. */
function scoreAnswer(score: number, levels: number) {
  const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, level) => [String(level), level === Math.round(score) ? 1 : 0]));
  const legend = Object.fromEntries(Array.from({ length: levels }, (_, level) => [String(level), `level ${level}`]));
  return { type: "score", score, legend, probabilities, confidence: 0.9 };
}

/** A System One response with the given raw Score answers (positions on each question's levels). */
function response(scores: Record<GradeDimension, number>, model = "jev-1.13.0") {
  return {
    model,
    answers: Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, scoreAnswer(scores[dimension], TAKE_GRADE_QUESTIONS[dimension].criteria.length)])
    ),
    usage: { input_tokens: 412, output_tokens: 30 }
  };
}

describe("TAKE_GRADE_QUESTIONS", () => {
  it("asks one Score question per dimension, within the API's level limits", () => {
    assert.deepEqual(Object.keys(TAKE_GRADE_QUESTIONS).sort(), [...DIMENSIONS].sort());
    for (const dimension of DIMENSIONS) {
      const question = TAKE_GRADE_QUESTIONS[dimension];
      assert.equal(question.type, "score");
      assert.ok(question.criteria.length >= 2 && question.criteria.length <= 10, dimension);
      assert.match(question.instructions, /`take`/, `${dimension} points at the take in state`);
    }
  });

  it("describes levels in words, never by number", () => {
    for (const dimension of DIMENSIONS) {
      for (const level of TAKE_GRADE_QUESTIONS[dimension].criteria) {
        assert.doesNotMatch(level, /\d/, level);
      }
    }
  });

  it("has a chat label for every level", () => {
    for (const dimension of DIMENSIONS) {
      assert.equal(GRADE_LABELS[dimension].length, TAKE_GRADE_QUESTIONS[dimension].criteria.length, dimension);
    }
  });

  it("weights boldness and spice to a whole temperature", () => {
    assert.equal(TEMP_WEIGHTS.boldness + TEMP_WEIGHTS.spice, 1);
  });
});

describe("dueInWords", () => {
  it("names today and tomorrow", () => {
    assert.equal(dueInWords("2026-09-25", TODAY), "by the end of today");
    assert.equal(dueInWords("2026-09-26", TODAY), "by the end of tomorrow");
  });

  it("counts days, then weeks, months, and years", () => {
    assert.equal(dueInWords("2026-09-27", TODAY), "within 2 days");
    assert.equal(dueInWords("2026-10-01", TODAY), "within 6 days");
    assert.equal(dueInWords("2026-10-08", TODAY), "within 13 days");
    assert.equal(dueInWords("2026-10-09", TODAY), "within 2 weeks");
    assert.equal(dueInWords("2026-11-20", TODAY), "within 8 weeks");
    assert.equal(dueInWords("2026-11-24", TODAY), "within 2 months");
    assert.equal(dueInWords("2027-09-25", TODAY), "within 12 months");
    assert.equal(dueInWords("2028-09-25", TODAY), "within 2 years");
  });

  it("crosses month and year ends", () => {
    assert.equal(dueInWords("2027-01-01", "2026-12-31"), "by the end of tomorrow");
  });

  it("treats a deadline that already passed as today", () => {
    assert.equal(dueInWords("2026-09-20", TODAY), "by the end of today");
  });
});

describe("takeGradeRequest", () => {
  it("sends the take and its deadline as state with every question", () => {
    const take = { take: "The Giants win", due: "by the end of today" };
    assert.deepEqual(takeGradeRequest(take), { model: JEV_MODEL, state: take, questions: TAKE_GRADE_QUESTIONS });
  });

  it("can ask a pinned model", () => {
    assert.equal(takeGradeRequest({ take: "The Giants win", due: "by the end of today" }, "jev-1.13.0").model, "jev-1.13.0");
  });
});

describe("parseTakeGrade", () => {
  it("scales each answer from its lowest level to its highest", () => {
    assert.deepEqual(parseTakeGrade(response({ boldness: 3, spice: 1.5, clarity: 3 })), {
      grade: { boldness: 0.75, spice: 0.5, clarity: 1 },
      model: "jev-1.13.0"
    });
    assert.deepEqual(parseTakeGrade(response({ boldness: 0, spice: 0, clarity: 0 }))?.grade, { boldness: 0, spice: 0, clarity: 0 });
  });

  it("rounds to two decimals", () => {
    assert.deepEqual(parseTakeGrade(response({ boldness: 2.4567, spice: 1, clarity: 2.9 }))?.grade, {
      boldness: 0.61,
      spice: 0.33,
      clarity: 0.97
    });
  });

  it("falls back to the requested model name without a reported one", () => {
    const body: Record<string, unknown> = response({ boldness: 2, spice: 2, clarity: 2 });
    delete body.model;
    assert.equal(parseTakeGrade(body)?.model, JEV_MODEL);
  });

  it("rejects anything that isn't a full set of Score answers", () => {
    const good = response({ boldness: 2, spice: 2, clarity: 2 });
    const without = (dimension: GradeDimension) => ({
      ...good,
      answers: Object.fromEntries(Object.entries(good.answers).filter(([key]) => key !== dimension))
    });
    const replacing = (answer: unknown) => ({ ...good, answers: { ...good.answers, spice: answer } });

    assert.equal(parseTakeGrade(null), null);
    assert.equal(parseTakeGrade("nope"), null);
    assert.equal(parseTakeGrade({ model: "jev-1.13.0" }), null);
    assert.equal(parseTakeGrade({ ...good, answers: [] }), null);
    assert.equal(parseTakeGrade(without("clarity")), null);
    assert.equal(parseTakeGrade(replacing({ type: "noul", noul: 0.9 })), null);
    assert.equal(parseTakeGrade(replacing({ type: "score", score: "2" })), null);
    assert.equal(parseTakeGrade(replacing({ type: "score", score: Number.NaN })), null);
    assert.equal(parseTakeGrade(replacing(scoreAnswer(-0.5, 4))), null);
    assert.equal(parseTakeGrade(replacing(scoreAnswer(3.5, 4))), null);
  });
});

describe("takeTemp", () => {
  const grade = (overrides: Partial<TakeGrade>): TakeGrade => ({ boldness: 0, spice: 0, clarity: 1, ...overrides });

  it("runs from 0° for a clear-cut sure thing to 100° for a clear-cut long shot that sets off the chat", () => {
    assert.equal(takeTemp(grade({})), 0);
    assert.equal(takeTemp(grade({ boldness: 1, spice: 1 })), 100);
  });

  it("weights boldness over spice", () => {
    assert.equal(takeTemp(grade({ boldness: 1 })), 70);
    assert.equal(takeTemp(grade({ spice: 1 })), 30);
    assert.equal(takeTemp(grade({ boldness: 0.5, spice: 0.5 })), 50);
  });

  it("halves takes nobody could settle", () => {
    assert.equal(takeTemp(grade({ boldness: 1, spice: 1, clarity: 0 })), 50);
    assert.equal(takeTemp(grade({ boldness: 1, spice: 1, clarity: 0.5 })), 75);
  });

  it("rounds to a whole number", () => {
    assert.equal(takeTemp({ boldness: 0.61, spice: 0.33, clarity: 0.97 }), 52);
  });
});

describe("gradeLabels", () => {
  it("labels each dimension by its nearest level: boldness, spice, clarity", () => {
    assert.deepEqual(gradeLabels({ boldness: 1, spice: 0.67, clarity: 1 }), ["long shot", "spicy", "clear-cut"]);
    assert.deepEqual(gradeLabels({ boldness: 0, spice: 0, clarity: 0 }), ["sure thing", "no debate", "unsettleable"]);
    assert.deepEqual(gradeLabels({ boldness: 0.55, spice: 0.2, clarity: 0.4 }), ["toss-up", "mild", "arguable"]);
  });
});
