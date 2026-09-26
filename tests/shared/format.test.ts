import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptedMessage,
  canceledMessage,
  confirmationMessage,
  flames,
  helpMessage,
  joinMessage,
  maskHandle,
  nominationMessage,
  outcomeLabel,
  quoteStatement,
  receiptDetailMessage,
  receiptListMessage,
  rejectedMessage,
  reminderMessage,
  renamedMessage,
  settledMessage,
  settleWords,
  setupMessage,
  statusLabel,
  typeLabel,
  type ChatReceipt
} from "../../app/shared/format";
import { parseBotMessage } from "../../app/shared/parse";
import { RECEIPT_TYPES } from "../../app/shared/types";

const TODAY = "2026-09-25";

const take: ChatReceipt = {
  number: 43,
  type: "take",
  status: "pending",
  capture: "manual",
  subjectName: "JR",
  statement: "The Giants win the division",
  madeOn: "2026-09-25",
  deadline: "2027-10-01",
  dateAmbiguous: false,
  heat: null
};

describe("maskHandle", () => {
  it("never reveals the full handle", () => {
    assert.equal(maskHandle("+15555550123"), "•••0123");
    assert.equal(maskHandle("jr@icloud.com"), "j•••@icloud.com");
    assert.equal(maskHandle("12"), "•••");
  });
});

describe("small labels", () => {
  it("renders flames", () => {
    assert.equal(flames(3), "🔥🔥🔥");
    assert.equal(flames(5), "🔥🔥🔥🔥🔥");
    assert.equal(flames(null), "unrated");
  });

  it("quotes statements with closing punctuation", () => {
    assert.equal(quoteStatement("The Giants win the division"), '"The Giants win the division."');
    assert.equal(quoteStatement("Will they?"), '"Will they?"');
    assert.equal(quoteStatement("Lock it in!"), '"Lock it in!"');
  });

  it("quotes captured messages exactly", () => {
    assert.equal(quoteStatement("warriors in 5 lol", true), '"warriors in 5 lol"');
  });

  it("labels statuses", () => {
    assert.equal(statusLabel({ type: "take", status: "pending", subjectName: "JR" }), "Pending");
    assert.equal(statusLabel({ type: "take", status: "nominated", subjectName: "JR" }), "Awaiting JR");
    assert.equal(statusLabel({ type: "take", status: "rejected", subjectName: "JR" }), "Declined");
    assert.equal(statusLabel({ type: "take", status: "canceled", subjectName: "JR" }), "Canceled");
    assert.equal(statusLabel({ type: "promise", status: "right", subjectName: "JR" }), "Kept");
  });

  it("labels types and outcomes", () => {
    assert.equal(typeLabel("take"), "Take");
    assert.equal(typeLabel("generic"), "Receipt");
    assert.equal(outcomeLabel("take", "right"), "Right");
    assert.equal(outcomeLabel("take", "wrong"), "Wrong");
    assert.equal(outcomeLabel("promise", "right"), "Kept");
    assert.equal(outcomeLabel("promise", "wrong"), "Broken");
    assert.equal(outcomeLabel("bet", "right"), "Won");
    assert.equal(outcomeLabel("bet", "wrong"), "Lost");
    assert.equal(outcomeLabel("conditional", "right"), "Fulfilled");
    assert.equal(outcomeLabel("conditional", "wrong"), "Not fulfilled");
    assert.equal(outcomeLabel("generic", "void"), "Void");
  });
});

describe("confirmationMessage", () => {
  it("matches the take confirmation format", () => {
    assert.equal(
      confirmationMessage(take, { today: TODAY, late: false }),
      ["🧾 TAKE LOCKED", "", "JR:", '"The Giants win the division."', "", "Due: Oct 1, 2027", "Heat: unrated", "", "Receipt #43"].join("\n")
    );
  });

  it("asks for confirmation of guessed dates", () => {
    const message = confirmationMessage({ ...take, deadline: "2027-06-01", dateAmbiguous: true }, { today: TODAY, late: false });
    assert.match(message, /Due: Jun 1, 2027 \(my best guess\)/);
    assert.match(message, /Reply "@receipts cancel 43" if I read the date wrong\./);
  });

  it("explains receipts without a date", () => {
    const message = confirmationMessage({ ...take, deadline: null }, { today: TODAY, late: false });
    assert.match(message, /Due: no date\. Settle it whenever\./);
  });

  it("omits heat for non-takes and names the type", () => {
    const message = confirmationMessage({ ...take, type: "promise", subjectName: "Ben" }, { today: TODAY, late: false });
    assert.equal(message.startsWith("🧾 PROMISE LOCKED"), true);
    assert.doesNotMatch(message, /Heat/);
    assert.equal(confirmationMessage({ ...take, type: "generic" }, { today: TODAY, late: false }).startsWith("🧾 RECEIPT LOCKED"), true);
    assert.equal(confirmationMessage({ ...take, type: "bet" }, { today: TODAY, late: false }).startsWith("🧾 BET LOCKED"), true);
    assert.equal(
      confirmationMessage({ ...take, type: "conditional" }, { today: TODAY, late: false }).startsWith("🧾 CONDITIONAL LOCKED"),
      true
    );
  });

  it("flags late catch-up confirmations in the same message", () => {
    const message = confirmationMessage(take, { today: TODAY, late: true });
    assert.match(message, /^🧾 TAKE LOCKED/);
    assert.match(message, /was offline/);
  });
});

describe("reminderMessage", () => {
  it("matches the deadline format", () => {
    assert.equal(
      reminderMessage({ ...take, heat: 4 }, "https://receipts.test/g/g1/r/43"),
      [
        "🚨 RECEIPT DUE",
        "",
        "On Sep 25, 2026, JR said:",
        "",
        '"The Giants win the division."',
        "",
        "Heat: 🔥🔥🔥🔥",
        "Time to settle it. 🧾",
        'Reply "@receipts 43 right" or "@receipts 43 wrong".',
        "https://receipts.test/g/g1/r/43"
      ].join("\n")
    );
  });

  it("celebrates five-flame takes", () => {
    assert.match(reminderMessage({ ...take, heat: 5 }, "u"), /🔥🔥🔥🔥🔥\nThat one's going in the vault\./);
  });

  it("uses type-specific verbs and skips heat for non-takes", () => {
    const message = reminderMessage({ ...take, type: "promise", subjectName: "Ben" }, "u");
    assert.match(message, /On Sep 25, 2026, Ben promised:/);
    assert.match(message, /Reply "@receipts 43 kept" or "@receipts 43 broken"\./);
    assert.doesNotMatch(message, /Heat/);
    assert.match(reminderMessage({ ...take, type: "bet" }, "u"), /JR bet:/);
  });
});

describe("other bot replies", () => {
  it("describes one receipt", () => {
    const message = receiptDetailMessage({ ...take, heat: 3 }, "https://receipts.test/g/g1/r/43");
    assert.match(message, /RECEIPT #43/);
    assert.match(message, /"The Giants win the division\."/);
    assert.match(message, /Due Oct 1, 2027/);
    assert.match(message, /🔥🔥🔥/);
    assert.match(message, /Pending/);
    assert.match(message, /https:\/\/receipts\.test\/g\/g1\/r\/43/);
    assert.match(receiptDetailMessage({ ...take, status: "right" }, "u"), /Right/);
  });

  it("lists receipts or explains an empty list", () => {
    const message = receiptListMessage("PENDING", [take, { ...take, number: 44, subjectName: "Connor", deadline: null }], "https://receipts.test/g/g1", "Nothing pending.");
    assert.match(message, /PENDING/);
    assert.match(message, /#43 JR: "The Giants win the division\." · due Oct 1, 2027/);
    assert.match(message, /#44 Connor/);
    assert.match(message, /https:\/\/receipts\.test\/g\/g1/);
    assert.match(receiptListMessage("PENDING", [], "u", "Nothing pending."), /Nothing pending\./);
  });

  it("explains commands", () => {
    const message = helpMessage("https://receipts.test");
    assert.match(message, /@receipts #take/);
    assert.match(message, /@receipts 43 right/);
    assert.match(message, /cancel/);
    assert.match(message, /join/);
    assert.match(message, /https:\/\/receipts\.test/);
  });

  it("formats links", () => {
    assert.match(joinMessage("https://receipts.test/join/ABC", 15), /https:\/\/receipts\.test\/join\/ABC/);
    assert.match(joinMessage("https://receipts.test/join/ABC", 15), /15 minutes/);
    assert.match(setupMessage("The Boys", "https://receipts.test/join/XYZ", 7), /The Boys/);
    assert.match(setupMessage("The Boys", "https://receipts.test/join/XYZ", 7), /7 days/);
    assert.match(canceledMessage(43), /#43/);

  });
});

describe("nomination messages", () => {
  const nominated: ChatReceipt = {
    number: 43,
    type: "take",
    status: "nominated",
    capture: "reply",
    subjectName: "JR",
    statement: "There is no chance the Warriors finish below the 4 seed.",
    madeOn: "2026-09-25",
    deadline: "2027-04-15",
    dateAmbiguous: false,
    heat: null
  };

  it("announces a nomination and tells the author how to accept", () => {
    assert.equal(
      nominationMessage(nominated, { nominatorName: "Alex", today: TODAY, late: false }),
      [
        "🧾 TAKE NOMINATED",
        "",
        "JR:",
        '"There is no chance the Warriors finish below the 4 seed."',
        "",
        "Due: Apr 15, 2027",
        "Nominated by Alex",
        "",
        'JR: reply "@receipts accept 43" to put it on the books.'
      ].join("\n")
    );
  });

  it("flags guessed dates and late processing on nominations", () => {
    const message = nominationMessage({ ...nominated, dateAmbiguous: true }, { nominatorName: "Alex", today: TODAY, late: true });
    assert.match(message, /Due: Apr 15, 2027 \(my best guess\)/);
    assert.match(message, /offline/);
  });

  it("never re-punctuates captured quotes", () => {
    const message = nominationMessage({ ...nominated, statement: "warriors in 5 lol" }, { nominatorName: "Alex", today: TODAY, late: false });
    assert.match(message, /^"warriors in 5 lol"$/m);
  });

  it("puts accepted takes on the record", () => {
    assert.equal(
      acceptedMessage({ ...nominated, status: "pending" }, "https://receipts.test/g/g1/r/43"),
      [
        "🔒 ON THE RECORD",
        "",
        "JR's take is official.",
        "",
        '"There is no chance the Warriors finish below the 4 seed."',
        "",
        "Due: Apr 15, 2027",
        "Now rate the heat. 🔥",
        "https://receipts.test/g/g1/r/43"
      ].join("\n")
    );
    const promise = acceptedMessage({ ...nominated, type: "promise", status: "pending" }, "u");
    assert.match(promise, /JR's promise is official\./);
    assert.doesNotMatch(promise, /heat/);
  });

  it("keeps declines light", () => {
    assert.equal(rejectedMessage({ number: 43, subjectName: "JR" }), "❌ JR declined Receipt #43.");
  });

  it("confirms a new display name", () => {
    assert.match(renamedMessage("JR"), /JR/);
  });

  it("shows a nomination's status in detail replies", () => {
    assert.match(receiptDetailMessage(nominated, "u"), /Status: Awaiting JR/);
  });
});

describe("settledMessage", () => {
  it("announces a correct take with its points", () => {
    assert.equal(
      settledMessage({ ...take, status: "right", heat: 4 }, { outcome: "right", settlerName: "Connor", points: 7 }),
      [
        "✅ RECEIPT #43: RIGHT",
        "",
        "JR:",
        '"The Giants win the division."',
        "",
        "Heat: 🔥🔥🔥🔥 · +7 Take Score",
        "Settled by Connor"
      ].join("\n")
    );
  });

  it("uses type-specific outcomes and skips points for non-takes", () => {
    const message = settledMessage({ ...take, type: "promise", status: "wrong" }, { outcome: "wrong", settlerName: "Sarah", points: null });
    assert.match(message, /^❌ RECEIPT #43: BROKEN/);
    assert.doesNotMatch(message, /Take Score/);
    assert.match(settledMessage({ ...take, status: "void" }, { outcome: "void", settlerName: "Sarah", points: 0 }), /^➖ RECEIPT #43: VOID/);
    assert.match(settledMessage({ ...take, status: "wrong", heat: 5 }, { outcome: "wrong", settlerName: "Sarah", points: 0 }), /\+0 Take Score/);
  });
});

describe("settleWords", () => {
  it("gives the chat words that settle each type", () => {
    assert.deepEqual(settleWords("take"), ["right", "wrong"]);
    assert.deepEqual(settleWords("generic"), ["right", "wrong"]);
    assert.deepEqual(settleWords("promise"), ["kept", "broken"]);
    assert.deepEqual(settleWords("bet"), ["won", "lost"]);
    assert.deepEqual(settleWords("conditional"), ["fulfilled", "not fulfilled"]);
  });

  it("gives words the bot reads as right and wrong", () => {
    for (const type of RECEIPT_TYPES) {
      const [yes, no] = settleWords(type);
      assert.deepEqual(parseBotMessage(`@receipts 43 ${yes}`, TODAY), { kind: "settle", number: 43, outcome: "right" });
      assert.deepEqual(parseBotMessage(`@receipts 43 ${no}`, TODAY), { kind: "settle", number: 43, outcome: "wrong" });
    }
  });
});
