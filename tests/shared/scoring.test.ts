import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeStandings, isFlameRating, medianHeat, standingFor, takePoints, type ScoredReceipt } from "../../app/shared/scoring";

describe("isFlameRating", () => {
  it("accepts integers 1 through 5", () => {
    for (const value of [1, 2, 3, 4, 5]) assert.equal(isFlameRating(value), true);
    for (const value of [0, 6, 2.5, "3", null, Number.NaN]) assert.equal(isFlameRating(value), false);
  });
});

describe("medianHeat", () => {
  it("is null without votes", () => {
    assert.equal(medianHeat([]), null);
  });

  it("takes the median and rounds half up", () => {
    assert.equal(medianHeat([3]), 3);
    assert.equal(medianHeat([1, 5]), 3);
    assert.equal(medianHeat([2, 3]), 3);
    assert.equal(medianHeat([1, 2, 2, 5]), 2);
    assert.equal(medianHeat([5, 5, 1]), 5);
    assert.equal(medianHeat([1, 1, 5, 5]), 3);
    assert.equal(medianHeat([4, 1, 1]), 1);
  });
});

describe("takePoints", () => {
  it("awards heat-scaled points only for correct takes", () => {
    assert.equal(takePoints({ type: "take", status: "right", heat: 1 }), 1);
    assert.equal(takePoints({ type: "take", status: "right", heat: 2 }), 2);
    assert.equal(takePoints({ type: "take", status: "right", heat: 3 }), 4);
    assert.equal(takePoints({ type: "take", status: "right", heat: 4 }), 7);
    assert.equal(takePoints({ type: "take", status: "right", heat: 5 }), 12);
    assert.equal(takePoints({ type: "take", status: "right", heat: null }), 1);
    assert.equal(takePoints({ type: "take", status: "wrong", heat: 5 }), 0);
    assert.equal(takePoints({ type: "take", status: "pending", heat: 5 }), 0);
    assert.equal(takePoints({ type: "take", status: "void", heat: 5 }), 0);
    assert.equal(takePoints({ type: "promise", status: "right", heat: 5 }), 0);
  });
});

const receipts: ScoredReceipt[] = [
  { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "right", heat: 4 },
  { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "wrong", heat: 2 },
  { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "pending", heat: 3 },
  { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "void", heat: 5 },
  { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "canceled", heat: 5 },
  { subjectRef: "n:jr", subjectName: "JR", type: "promise", status: "right", heat: null },
  { subjectRef: "u:connor", subjectName: "Connor", type: "take", status: "right", heat: 5 },
  { subjectRef: "u:connor", subjectName: "Connor", type: "take", status: "right", heat: null },
  { subjectRef: "n:sarah", subjectName: "Sarah", type: "bet", status: "right", heat: null }
];

describe("computeStandings", () => {
  it("scores takes per subject and sorts by Take Score", () => {
    assert.deepEqual(computeStandings(receipts), [
      {
        subjectRef: "u:connor",
        name: "Connor",
        takeScore: 13,
        right: 2,
        wrong: 0,
        pending: 0,
        accuracy: 1,
        averageHeat: 5
      },
      {
        subjectRef: "n:jr",
        name: "JR",
        takeScore: 7,
        right: 1,
        wrong: 1,
        pending: 1,
        accuracy: 0.5,
        averageHeat: 3
      }
    ]);
  });

  it("uses display-name overrides", () => {
    const standings = computeStandings(receipts, new Map([["u:connor", "Connor K."]]));
    assert.equal(standings[0].name, "Connor K.");
  });

  it("breaks score ties by right calls, then name", () => {
    const tied: ScoredReceipt[] = [
      { subjectRef: "n:b", subjectName: "Bea", type: "take", status: "right", heat: 2 },
      { subjectRef: "n:a", subjectName: "Al", type: "take", status: "right", heat: 1 },
      { subjectRef: "n:a", subjectName: "Al", type: "take", status: "right", heat: 1 },
      { subjectRef: "n:c", subjectName: "Cy", type: "take", status: "right", heat: 2 }
    ];
    assert.deepEqual(
      computeStandings(tied).map((standing) => standing.name),
      ["Al", "Bea", "Cy"]
    );
  });
});

describe("standingFor", () => {
  it("returns zeroes for a subject without takes", () => {
    assert.deepEqual(standingFor("n:sarah", "Sarah", receipts), {
      subjectRef: "n:sarah",
      name: "Sarah",
      takeScore: 0,
      right: 0,
      wrong: 0,
      pending: 0,
      accuracy: null,
      averageHeat: null
    });
  });

  it("matches the computed standing for a subject with takes", () => {
    assert.deepEqual(standingFor("n:jr", "JR", receipts), computeStandings(receipts)[1]);
  });
});

describe("nominations and scoring", () => {
  it("ignores nominated and rejected takes entirely", () => {
    const withNominations: ScoredReceipt[] = [
      ...receipts,
      { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "nominated", heat: 5 },
      { subjectRef: "n:jr", subjectName: "JR", type: "take", status: "rejected", heat: 1 },
      { subjectRef: "n:new", subjectName: "Newbie", type: "take", status: "nominated", heat: null }
    ];
    assert.deepEqual(computeStandings(withNominations), computeStandings(receipts));
    assert.deepEqual(standingFor("n:jr", "JR", withNominations), standingFor("n:jr", "JR", receipts));
  });
});
