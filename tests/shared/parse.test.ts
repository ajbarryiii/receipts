import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferReceiptType, MAX_STATEMENT_LENGTH, mentionsBot, nameKey, parseBotMessage, type BotCommand, type ReceiptDraft } from "../../app/shared/parse";

const TODAY = "2026-09-25";

function parse(text: string): BotCommand {
  return parseBotMessage(text, TODAY);
}

function draft(text: string): ReceiptDraft {
  const command = parse(text);
  assert.equal(command.kind, "create", `expected a receipt for: ${text} (got ${JSON.stringify(command)})`);
  return (command as { kind: "create"; draft: ReceiptDraft }).draft;
}

describe("mentionsBot", () => {
  it("matches @receipts as a standalone mention", () => {
    assert.equal(mentionsBot("@receipts #take JR says X"), true);
    assert.equal(mentionsBot("lol @Receipts list"), true);
    assert.equal(mentionsBot("@RECEIPTS"), true);
    assert.equal(mentionsBot("receipts please"), false);
    assert.equal(mentionsBot("mail me at jr@receipts.com"), false);
    assert.equal(mentionsBot("@receiptsbot"), false);
  });
});

describe("parseBotMessage commands", () => {
  it("ignores messages without a mention", () => {
    assert.deepEqual(parse("JR says the Giants win"), { kind: "none" });
  });

  it("treats a bare mention or help as help", () => {
    assert.deepEqual(parse("@receipts"), { kind: "help" });
    assert.deepEqual(parse("@receipts help"), { kind: "help" });
    assert.deepEqual(parse("@receipts ?"), { kind: "help" });
  });

  it("recognizes simple commands case-insensitively", () => {
    assert.deepEqual(parse("@receipts upcoming"), { kind: "upcoming" });
    assert.deepEqual(parse("@receipts UPCOMING?"), { kind: "upcoming" });
    assert.deepEqual(parse("@receipts list"), { kind: "list" });
    assert.deepEqual(parse("@receipts mine"), { kind: "mine" });
    assert.deepEqual(parse("@receipts join"), { kind: "join" });
    assert.deepEqual(parse("@receipts setup"), { kind: "setup" });
  });

  it("recognizes numbered commands", () => {
    assert.deepEqual(parse("@receipts 43"), { kind: "show", number: 43 });
    assert.deepEqual(parse("@receipts #43"), { kind: "show", number: 43 });
    assert.deepEqual(parse("@receipts cancel 43"), { kind: "cancel", number: 43 });
    assert.deepEqual(parse("@receipts cancel #43"), { kind: "cancel", number: 43 });
    assert.deepEqual(parse("@receipts 43 right"), { kind: "settle", number: 43, outcome: "right" });
    assert.deepEqual(parse("@receipts 43 wrong"), { kind: "settle", number: 43, outcome: "wrong" });
    assert.deepEqual(parse("@receipts #43 void"), { kind: "settle", number: 43, outcome: "void" });
    assert.deepEqual(parse("@receipts 43 RIGHT!"), { kind: "settle", number: 43, outcome: "right" });
  });

  it("accepts type-specific settlement words", () => {
    assert.deepEqual(parse("@receipts 43 kept"), { kind: "settle", number: 43, outcome: "right" });
    assert.deepEqual(parse("@receipts 43 won"), { kind: "settle", number: 43, outcome: "right" });
    assert.deepEqual(parse("@receipts 43 fulfilled"), { kind: "settle", number: 43, outcome: "right" });
    assert.deepEqual(parse("@receipts 43 broken"), { kind: "settle", number: 43, outcome: "wrong" });
    assert.deepEqual(parse("@receipts 43 lost"), { kind: "settle", number: 43, outcome: "wrong" });
    assert.deepEqual(parse("@receipts 43 not fulfilled"), { kind: "settle", number: 43, outcome: "wrong" });
  });

  it("asks which receipt when cancel has no number", () => {
    assert.equal(parse("@receipts cancel").kind, "invalid");
  });

  it("treats command words followed by other text as receipts", () => {
    assert.equal(parse("@receipts list of reasons JR is wrong").kind, "create");
  });

  it("treats inherited object keys as ordinary text, not commands or outcomes", () => {
    assert.equal(parse("@receipts constructor").kind, "create");
    assert.equal(parse("@receipts __proto__").kind, "create");
    assert.equal(parse("@receipts 43 constructor").kind, "create");
  });
});

describe("parseBotMessage receipts", () => {
  it("parses the canonical tagged take", () => {
    assert.deepEqual(draft("@receipts #take JR says the Giants win the division by Oct 1 2027"), {
      type: "take",
      typeExplicit: true,
      subject: { kind: "named", name: "JR" },
      statement: "The Giants win the division",
      deadline: { date: "2027-10-01", ambiguous: false }
    });
  });

  it("infers a take from a deadline", () => {
    assert.deepEqual(draft("@receipts Jack says the Warriors win 60 games by April 12 2027"), {
      type: "take",
      typeExplicit: false,
      subject: { kind: "named", name: "Jack" },
      statement: "The Warriors win 60 games",
      deadline: { date: "2027-04-12", ambiguous: false }
    });
    assert.deepEqual(draft("@receipts Connor says OpenAI IPOs before 2028"), {
      type: "take",
      typeExplicit: false,
      subject: { kind: "named", name: "Connor" },
      statement: "OpenAI IPOs",
      deadline: { date: "2028-01-01", ambiguous: false }
    });
  });

  it("infers a take from future tense without a deadline", () => {
    const parsed = draft("@receipts Connor says OpenAI will IPO");
    assert.equal(parsed.type, "take");
    assert.equal(parsed.deadline, null);
    assert.equal(parsed.statement, "OpenAI will IPO");
  });

  it("parses 'Name: statement' and keeps inner capitalization", () => {
    assert.deepEqual(draft("@receipts #take Sarah: iPhone Fold before September 2027"), {
      type: "take",
      typeExplicit: true,
      subject: { kind: "named", name: "Sarah" },
      statement: "iPhone Fold",
      deadline: { date: "2027-09-01", ambiguous: false }
    });
  });

  it("keeps complex conditional text intact", () => {
    assert.deepEqual(
      draft("@receipts #conditional JR will admit he's wrong about Kerr if Kuminga averages 20 PPG by the All-Star break"),
      {
        type: "conditional",
        typeExplicit: true,
        subject: { kind: "named", name: "JR" },
        statement: "JR will admit he's wrong about Kerr if Kuminga averages 20 PPG by the All-Star break",
        deadline: null
      }
    );
  });

  it("parses promises, tagged or inferred from the verb", () => {
    assert.deepEqual(draft("@receipts #promise Ben says he'll run a marathon if the Giants make the playoffs"), {
      type: "promise",
      typeExplicit: true,
      subject: { kind: "named", name: "Ben" },
      statement: "He'll run a marathon if the Giants make the playoffs",
      deadline: null
    });
    const inferred = draft("@receipts Ben promises he'll run a marathon if the Giants make the playoffs");
    assert.equal(inferred.type, "promise");
    assert.equal(inferred.typeExplicit, false);
  });

  it("parses bets without stripping their date", () => {
    assert.deepEqual(draft("@receipts #bet Loser buys dinner if Nvidia is below $150 on Dec 31"), {
      type: "bet",
      typeExplicit: true,
      subject: { kind: "sender" },
      statement: "Loser buys dinner if Nvidia is below $150 on Dec 31",
      deadline: { date: "2026-12-31", ambiguous: true }
    });
    assert.equal(draft("@receipts loser buys dinner if Nvidia is below $150 on Dec 31").type, "bet");
    const firstPerson = draft("@receipts I bet the Giants win tomorrow");
    assert.equal(firstPerson.type, "bet");
    assert.deepEqual(firstPerson.subject, { kind: "sender" });
    assert.equal(firstPerson.statement, "The Giants win tomorrow");
  });

  it("infers conditionals from if-clauses", () => {
    const parsed = draft("@receipts JR will shave his head if the Warriors miss the playoffs");
    assert.equal(parsed.type, "conditional");
    assert.deepEqual(parsed.subject, { kind: "named", name: "JR" });
  });

  it("uses the sender for first-person and subjectless receipts", () => {
    assert.deepEqual(draft("@receipts I say the Niners go 12-5 by Jan 10"), {
      type: "take",
      typeExplicit: false,
      subject: { kind: "sender" },
      statement: "The Niners go 12-5",
      deadline: { date: "2027-01-10", ambiguous: true }
    });
    assert.deepEqual(draft("@receipts me: Giants in 5").subject, { kind: "sender" });
    assert.deepEqual(draft("@receipts The Giants win the division by Oct 1 2027").subject, { kind: "sender" });
    assert.deepEqual(draft("@receipts #promise I will bring snacks tomorrow").subject, { kind: "sender" });
    assert.deepEqual(draft("@receipts I will shave my head if they lose").subject, { kind: "sender" });
  });

  it("falls back to generic receipts", () => {
    assert.deepEqual(draft("@receipts JR said pineapple pizza is elite"), {
      type: "generic",
      typeExplicit: false,
      subject: { kind: "named", name: "JR" },
      statement: "Pineapple pizza is elite",
      deadline: null
    });
  });

  it("accepts two-word names", () => {
    assert.deepEqual(draft("@receipts Big Mike says the Kings make the playoffs by April 20 2027").subject, {
      kind: "named",
      name: "Big Mike"
    });
  });

  it("accepts tags anywhere and tag aliases", () => {
    const tagged = draft("@receipts JR says the Giants win #take");
    assert.equal(tagged.type, "take");
    assert.equal(tagged.typeExplicit, true);
    assert.equal(tagged.statement, "The Giants win");
    assert.equal(draft("@receipts #prediction JR says the Giants win").type, "take");
    assert.equal(draft("@receipts #if JR says he'll cry if they lose").type, "conditional");
    assert.equal(draft("@receipts #generic JR says the Giants win by Oct 1 2027").type, "generic");
  });

  it("keeps unknown hashtags in the statement", () => {
    assert.equal(draft("@receipts #take JR says #nba is rigged").statement, "#nba is rigged");
    const unknownTag = draft("@receipts #constructor the Giants win");
    assert.equal(unknownTag.type, "generic");
    assert.equal(unknownTag.typeExplicit, false);
    assert.equal(unknownTag.statement, "#constructor the Giants win");
  });

  it("strips quotes and trailing punctuation", () => {
    assert.equal(draft('@receipts JR: "The Giants win the division by Oct 1 2027."').statement, "The Giants win the division");
    assert.equal(draft("@receipts #take JR says the Giants win the division by Oct 1 2027.").statement, "The Giants win the division");
    assert.equal(draft("@receipts #take JR asks will the Giants ever win?").statement.endsWith("?"), true);
  });

  it("reads text before the mention when nothing follows it", () => {
    const parsed = draft("JR says the Giants win the division by Oct 1 2027 @receipts");
    assert.deepEqual(parsed.subject, { kind: "named", name: "JR" });
    assert.equal(parsed.statement, "The Giants win the division");
  });

  it("uses only the text after a mid-message mention", () => {
    assert.deepEqual(draft("lol ok @receipts JR says the Giants win by Oct 1 2027").subject, { kind: "named", name: "JR" });
  });

  it("truncates very long statements", () => {
    const parsed = draft(`@receipts #take JR says ${"the Giants win ".repeat(40)}`);
    assert.equal(parsed.statement.length, MAX_STATEMENT_LENGTH);
    assert.equal(parsed.statement.endsWith("…"), true);
  });

  it("rejects receipts with nothing to record", () => {
    assert.equal(parse("@receipts #take").kind, "invalid");
    assert.equal(parse("@receipts #take by Friday").kind, "invalid");
    assert.equal(parse("@receipts JR says").kind, "invalid");
  });
});

describe("nameKey", () => {
  it("normalizes case, punctuation, and spacing", () => {
    assert.equal(nameKey("JR"), "jr");
    assert.equal(nameKey("J.R."), "jr");
    assert.equal(nameKey("  Big   Mike "), "big mike");
    assert.equal(nameKey("Zoë"), "zoë");
  });
});

describe("nomination and identity commands", () => {
  it("recognizes accept, reject, and nominations", () => {
    assert.deepEqual(parse("@receipts accept 43"), { kind: "accept", number: 43 });
    assert.deepEqual(parse("@receipts accept #43"), { kind: "accept", number: 43 });
    assert.deepEqual(parse("@receipts ACCEPT 43!"), { kind: "accept", number: 43 });
    assert.deepEqual(parse("@receipts reject 43"), { kind: "reject", number: 43 });
    assert.deepEqual(parse("@receipts decline 43"), { kind: "reject", number: 43 });
    assert.deepEqual(parse("@receipts nominations"), { kind: "nominations" });
    assert.equal(parse("@receipts accept").kind, "invalid");
    assert.equal(parse("@receipts reject").kind, "invalid");
  });

  it("sets a display name with 'call me'", () => {
    assert.deepEqual(parse("@receipts call me JR"), { kind: "rename", name: "JR" });
    assert.deepEqual(parse('@receipts call me "Big Mike"'), { kind: "rename", name: "Big Mike" });
    assert.equal(parse("@receipts call me").kind, "invalid");
    assert.equal(parse(`@receipts call me ${"x".repeat(31)}`).kind, "invalid");
  });
});

describe("parseBotMessage replies", () => {
  function reply(text: string): BotCommand {
    return parseBotMessage(text, TODAY, { isReply: true });
  }

  it("captures the replied-to message with lightweight commands", () => {
    assert.deepEqual(reply("@receipts"), { kind: "capture", type: null, deadline: null });
    assert.deepEqual(reply("@receipts #take"), { kind: "capture", type: "take", deadline: null });
    assert.deepEqual(reply("@receipts #take Apr 15"), {
      kind: "capture",
      type: "take",
      deadline: { date: "2027-04-15", ambiguous: true }
    });
    assert.deepEqual(reply("@receipts #take by Apr 15 2027"), {
      kind: "capture",
      type: "take",
      deadline: { date: "2027-04-15", ambiguous: false }
    });
    assert.deepEqual(reply("@receipts #promise by July"), {
      kind: "capture",
      type: "promise",
      deadline: { date: "2027-07-31", ambiguous: true }
    });
    assert.deepEqual(reply("@receipts #conditional EOY"), {
      kind: "capture",
      type: "conditional",
      deadline: { date: "2026-12-31", ambiguous: false }
    });
    assert.deepEqual(reply("@receipts by April 15 2027"), {
      kind: "capture",
      type: null,
      deadline: { date: "2027-04-15", ambiguous: false }
    });
  });

  it("reads a bare month as a deadline", () => {
    assert.deepEqual(reply("@receipts #take July"), {
      kind: "capture",
      type: "take",
      deadline: { date: "2027-07-31", ambiguous: true }
    });
  });

  it("ignores punctuation and emoji around the deadline", () => {
    assert.equal(reply("@receipts #take by Apr 15 2027 🔥🔥").kind, "capture");
    assert.equal(reply("@receipts #take, by Apr 15 2027!").kind, "capture");
  });

  it("still runs commands sent as replies", () => {
    assert.deepEqual(reply("@receipts accept 43"), { kind: "accept", number: 43 });
    assert.deepEqual(reply("@receipts help"), { kind: "help" });
    assert.deepEqual(reply("@receipts 43"), { kind: "show", number: 43 });
  });

  it("treats a full manual receipt as manual even when sent as a reply", () => {
    assert.equal(reply("@receipts #take JR says the Giants win the division by Oct 1 2027").kind, "create");
  });

  it("asks for a real date instead of guessing", () => {
    const result = reply("@receipts #take by the All-Star break");
    assert.equal(result.kind, "invalid");
    assert.match((result as { reason: string }).reason, /date/);
  });

  it("asks for a name when a reply spells out a take without one", () => {
    const result = reply("@receipts #take Warriors finish top 4 by Apr 15 2027");
    assert.equal(result.kind, "invalid");
    assert.match((result as { reason: string }).reason, /@receipts #take <name>: Warriors finish top 4 by Apr 15 2027/);
  });

  it("does not capture without a reply", () => {
    assert.deepEqual(parse("@receipts"), { kind: "help" });
    assert.equal(parse("@receipts #take by Apr 15 2027").kind, "invalid");
  });
});

describe("inferReceiptType", () => {
  it("infers from a captured message", () => {
    assert.equal(inferReceiptType("There is no chance the Warriors finish below the 4 seed.", true), "take");
    assert.equal(inferReceiptType("I'll shave my head if they lose", true), "conditional");
    assert.equal(inferReceiptType("Loser buys dinner", false), "bet");
    assert.equal(inferReceiptType("Pineapple pizza is elite", false), "generic");
    assert.equal(inferReceiptType("I promise to bring snacks", false), "promise");
    assert.equal(inferReceiptType("I bet the Giants win tomorrow", true), "bet");
  });
});

describe("take blitz commands", () => {
  it("starts the blitz with lfg", () => {
    assert.deepEqual(parse("@receipts lfg"), { kind: "lfg" });
    assert.deepEqual(parse("@receipts LFG!!"), { kind: "lfg" });
  });

  it("keeps the crown out of chosen names", () => {
    const command = parse("@receipts call me 👑 Sam");
    assert.equal(command.kind, "invalid");
    assert.match((command as { reason: string }).reason, /Nice try/);
  });
});

describe("callout commands", () => {
  it("exposes someone with a reply", () => {
    assert.deepEqual(parseBotMessage("@receipts exposed", TODAY, { isReply: true }), { kind: "exposed" });
    assert.deepEqual(parseBotMessage("@receipts EXPOSED!", TODAY, { isReply: true }), { kind: "exposed" });
    assert.deepEqual(parse("@receipts exposed"), { kind: "exposed" });
  });

  it("claims a called shot with a reply", () => {
    for (const text of ["@receipts told you so", "@receipts told ya", "@receipts i told you so!", "@receipts called it"]) {
      assert.deepEqual(parseBotMessage(text, TODAY, { isReply: true }), { kind: "toldYouSo" }, text);
    }
  });
});
