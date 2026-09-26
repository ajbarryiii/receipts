import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import { dueAtFor } from "../../app/shared/dates";
import { maskHandle } from "../../app/shared/format";
import { account, CONNOR_HANDLE, guest, JR_HANDLE, signedOut, TestApp, tokenFrom } from "./harness";

const DAY = 24 * 60 * 60 * 1000;
// Noon PDT on Friday, Sep 25 2026.
const NOON = Date.UTC(2026, 8, 25, 19, 0);

const JR = account("user-jr", "JR Smith");
const CONNOR = account("user-connor", "Connor K");
const SARAH = account("user-sarah", "Sarah P");
const OUTSIDER = account("user-outsider", "Stranger");

function useClock(t: TestContext, start = NOON) {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

let app: TestApp;

beforeEach(() => {
  app = new TestApp();
});

async function groupId(): Promise<string> {
  const [group] = await app.rows("groups");
  return group.id as string;
}

async function receiptId(number: number): Promise<string> {
  const receipt = (await app.rows("receipts")).find((row) => row.number === number);
  assert.ok(receipt, `receipt #${number}`);
  return receipt.id as string;
}

/** JR links their iMessage identity; Connor and Sarah join through the group invite. */
async function setUpGroup(): Promise<string> {
  await app.mutation("redeemInvite", JR, tokenFrom((await app.chat("@receipts join", { senderHandle: JR_HANDLE })).reply));
  const invite = tokenFrom((await app.chat("@receipts setup")).reply);
  await app.mutation("redeemInvite", CONNOR, invite);
  await app.mutation("redeemInvite", SARAH, invite);
  return groupId();
}

describe("web access", () => {
  it("requires a Google account", async () => {
    await assert.rejects(app.query("home", signedOut), /Sign in/);
    await assert.rejects(app.query("home", guest("guest-1")), /Sign in/);
    await assert.rejects(app.mutation("redeemInvite", guest("guest-1"), "TOKEN"), /Sign in/);
  });

  it("hides groups from non-members", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2027");
    const receipt = await receiptId(1);
    assert.equal(await app.query("group", OUTSIDER, id), null);
    assert.equal(await app.query("receipt", OUTSIDER, id, 1), null);
    assert.equal(await app.query("profile", OUTSIDER, id, "n:jr"), null);
    await assert.rejects(app.mutation("voteHeat", OUTSIDER, receipt, 3), /not a member/);
    await assert.rejects(app.mutation("settleReceipt", OUTSIDER, receipt, "right", null), /not a member/);
    await assert.rejects(app.mutation("setDeadline", OUTSIDER, receipt, "2027-01-01"), /not a member/);
    await assert.rejects(app.mutation("renameGroup", OUTSIDER, id, "Mine now"), /not a member/);
    await assert.rejects(app.mutation("claimName", OUTSIDER, id, "n:jr"), /not a member/);
    assert.equal(await app.query("group", JR, "not-a-group"), null);
  });

  it("never exposes raw iMessage handles", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts I say the Giants win by Oct 1 2027", { senderHandle: CONNOR_HANDLE });
    const invite = tokenFrom((await app.chat("@receipts join", { senderHandle: CONNOR_HANDLE })).reply);
    const views = [
      await app.query("home", JR),
      await app.query("group", JR, id),
      await app.query("receipt", JR, id, 1),
      await app.query("invite", CONNOR, invite)
    ];
    for (const view of views) {
      const serialized = JSON.stringify(view);
      assert.equal(serialized.includes(CONNOR_HANDLE), false);
      assert.equal(serialized.includes(JR_HANDLE), false);
    }
  });
});

describe("linking and invites", () => {
  it("links an identity, makes the first member owner, and backfills their receipts", async (t) => {
    useClock(t);
    await app.chat("@receipts I say the Giants win by Oct 1 2027", { senderHandle: JR_HANDLE });
    const token = tokenFrom((await app.chat("@receipts join", { senderHandle: JR_HANDLE })).reply);

    const preview = await app.query("invite", JR, token);
    assert.deepEqual(preview, {
      kind: "join",
      groupId: await groupId(),
      groupName: "The Boys",
      handleHint: maskHandle(JR_HANDLE),
      status: "valid",
      alreadyMember: false
    });

    assert.deepEqual(await app.mutation("redeemInvite", JR, token), { groupId: await groupId() });
    const [membership] = await app.rows("memberships");
    assert.equal(membership.userId, "user-jr");
    assert.equal(membership.role, "owner");
    const [identity] = await app.rows("identities");
    assert.equal(identity.userId, "user-jr");
    const [receipt] = await app.rows("receipts");
    assert.equal(receipt.subjectUserId, "user-jr");
    assert.equal(receipt.createdByUserId, "user-jr");
    const [profile] = await app.rows("profiles");
    assert.equal(profile.displayName, "JR Smith");

    // Redeeming again as the same account is harmless; another account cannot reuse the link.
    assert.deepEqual(await app.mutation("redeemInvite", JR, token), { groupId: await groupId() });
    await assert.rejects(app.mutation("redeemInvite", CONNOR, token), /already been used/);
    assert.equal((await app.query("invite", CONNOR, token))?.status, "used");
  });

  it("uses linked names for new receipts about the sender", async (t) => {
    useClock(t);
    await setUpGroup();
    const result = await app.chat("@receipts I say the Giants win by Oct 1 2027", { senderHandle: JR_HANDLE });
    assert.match(result.reply ?? "", /JR Smith:/);
    const [receipt] = await app.rows("receipts");
    assert.equal(receipt.subjectUserId, "user-jr");
    assert.equal(receipt.createdByUserId, "user-jr");
  });

  it("does not transfer a linked identity through another join link", async (t) => {
    useClock(t);
    await app.chat("@receipts I say the Giants win by Oct 1 2027");
    const first = tokenFrom((await app.chat("@receipts join")).reply);
    const spare = tokenFrom((await app.chat("@receipts join")).reply);
    await app.mutation("redeemInvite", JR, first);
    const later = tokenFrom((await app.chat("@receipts join")).reply);

    for (const token of [spare, later]) {
      assert.equal((await app.query("invite", CONNOR, token))?.status, "used");
      await assert.rejects(app.mutation("redeemInvite", CONNOR, token), /already linked to another account/);
    }
    const [identity] = await app.rows("identities");
    const [receipt] = await app.rows("receipts");
    assert.equal(identity.userId, "user-jr");
    assert.equal(receipt.subjectUserId, "user-jr");
    assert.equal(receipt.createdByUserId, "user-jr");
    assert.equal((await app.rows("memberships")).length, 1);

    // A fresh link is still harmless when redeemed by the account already linked.
    assert.equal((await app.query("invite", JR, later))?.status, "valid");
    assert.deepEqual(await app.mutation("redeemInvite", JR, later), { groupId: await groupId() });
  });

  it("expires identity links after 15 minutes", async (t) => {
    const clock = useClock(t);
    const token = tokenFrom((await app.chat("@receipts join")).reply);
    clock.now += 15 * 60 * 1000 + 1;
    assert.equal((await app.query("invite", JR, token))?.status, "expired");
    await assert.rejects(app.mutation("redeemInvite", JR, token), /expired/);
    assert.equal(await app.query("invite", JR, "UNKNOWNTOKEN1"), null);
    await assert.rejects(app.mutation("redeemInvite", JR, "UNKNOWNTOKEN1"), /not valid/);
  });

  it("lets several people use a group invite until it expires", async (t) => {
    const clock = useClock(t);
    const id = await setUpGroup();
    const roles = new Map((await app.rows("memberships")).map((row) => [row.userId, row.role]));
    assert.deepEqual(Object.fromEntries(roles), { "user-jr": "owner", "user-connor": "member", "user-sarah": "member" });
    assert.equal((await app.query("invite", SARAH, tokenFrom((await app.chat("@receipts setup")).reply)))?.alreadyMember, true);

    const late = tokenFrom((await app.chat("@receipts setup")).reply);
    clock.now += 7 * DAY + 1;
    await assert.rejects(app.mutation("redeemInvite", OUTSIDER, late), /expired/);
    assert.equal(await app.query("group", OUTSIDER, id), null);
  });

  it("lists a member's groups", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    assert.deepEqual(await app.query("home", CONNOR), {
      displayName: "Connor K",
      groups: [{ id, name: "The Boys", role: "member" }]
    });
    assert.deepEqual(await app.query("home", OUTSIDER), { displayName: "Stranger", groups: [] });
  });
});

describe("heat voting", () => {
  it("records votes and publishes the median", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028");
    const receipt = await receiptId(1);

    assert.deepEqual(await app.mutation("voteHeat", JR, receipt, 4), { heat: 4 });
    assert.deepEqual(await app.mutation("voteHeat", SARAH, receipt, 2), { heat: 3 });
    assert.deepEqual(await app.mutation("voteHeat", SARAH, receipt, 1), { heat: 3 });
    assert.deepEqual(await app.mutation("voteHeat", SARAH, receipt, 5), { heat: 5 });
    assert.equal((await app.rows("heatVotes")).length, 2);

    const detail = await app.query("receipt", SARAH, id, 1);
    assert.equal(detail?.card.heat, 5);
    assert.equal(detail?.card.voteCount, 2);
    assert.equal(detail?.myVote, 5);
    assert.deepEqual(
      detail?.votes.map(({ name, flames, isMine }) => ({ name, flames, isMine })).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: "JR Smith", flames: 4, isMine: false },
        { name: "Sarah P", flames: 5, isMine: true }
      ]
    );
  });

  it("rejects invalid ratings and non-takes", async (t) => {
    useClock(t);
    await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028");
    await app.chat("@receipts #promise Ben says he'll run a marathon");
    for (const flames of [0, 6, 2.5]) {
      await assert.rejects(app.mutation("voteHeat", JR, await receiptId(1), flames), /1 to 5/);
    }
    await assert.rejects(app.mutation("voteHeat", JR, await receiptId(2), 3), /Only takes/);
    await assert.rejects(app.mutation("voteHeat", JR, "missing", 3), /not found/);
  });

  it("does not let people rate their own takes", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts I say the Giants win by Oct 1 2027", { senderHandle: JR_HANDLE });
    await assert.rejects(app.mutation("voteHeat", JR, await receiptId(1), 5), /your own take/);
    assert.match((await app.query("receipt", JR, id, 1))?.voteBlockedReason ?? "", /your own take/);
    assert.equal((await app.query("receipt", CONNOR, id, 1))?.voteBlockedReason, null);
  });

  it("closes voting at the deadline and at settlement", async (t) => {
    const clock = useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before Oct 1 2026");
    await app.chat("@receipts #take Connor says the Giants win by Oct 1 2027");
    await app.mutation("settleReceipt", SARAH, await receiptId(2), "wrong", null);
    await assert.rejects(app.mutation("voteHeat", JR, await receiptId(2), 3), /closed/);

    clock.now = dueAtFor("2026-10-01", -420) + 1;
    await assert.rejects(app.mutation("voteHeat", JR, await receiptId(1), 3), /closed/);
    assert.match((await app.query("receipt", JR, id, 1))?.voteBlockedReason ?? "", /closed/);
  });
});

describe("settlement and scoring", () => {
  it("settles receipts, freezes heat, and scores takes", async (t) => {
    const clock = useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028");
    await app.chat("@receipts #take Connor says the Warriors win 60 games by April 12 2027");
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2027");
    await app.mutation("voteHeat", JR, await receiptId(1), 4);
    await app.mutation("voteHeat", SARAH, await receiptId(1), 4);
    await app.mutation("voteHeat", SARAH, await receiptId(2), 5);

    clock.now += DAY;
    await app.mutation("settleReceipt", SARAH, await receiptId(1), "right", "IPO priced at $300B");
    await app.mutation("settleReceipt", JR, await receiptId(2), "wrong", null);

    const settled = await app.query("receipt", CONNOR, id, 1);
    assert.equal(settled?.card.status, "right");
    assert.equal(settled?.card.heat, 4);
    assert.equal(settled?.card.settledAt, clock.now);
    assert.equal(settled?.points, 7);
    assert.equal(settled?.canSettle, false);
    assert.deepEqual(settled?.settlements, [{ outcome: "right", settledByName: "Sarah P", notes: "IPO priced at $300B", at: clock.now }]);

    const group = await app.query("group", JR, id);
    const connor = group?.standings.find((standing) => standing.subjectRef === "n:connor");
    assert.deepEqual(connor, {
      subjectRef: "n:connor",
      name: "Connor",
      takeScore: 7,
      right: 1,
      wrong: 1,
      pending: 0,
      accuracy: 0.5,
      averageHeat: 4.5
    });
    assert.deepEqual(group?.recentlySettled.map((card) => card.number), [2, 1]);
    assert.deepEqual(group?.pending.map((card) => card.number), [3]);
  });

  it("allows only owners to correct a settled outcome", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028");
    const receipt = await receiptId(1);
    await app.mutation("voteHeat", SARAH, receipt, 3);
    await app.mutation("settleReceipt", SARAH, receipt, "wrong", null);
    await assert.rejects(app.mutation("settleReceipt", SARAH, receipt, "right", null), /Only the group owner/);
    await app.mutation("settleReceipt", JR, receipt, "right", "Oops, it did happen");
    const detail = await app.query("receipt", JR, id, 1);
    assert.equal(detail?.card.status, "right");
    assert.equal(detail?.card.heat, 3);
    assert.equal(detail?.settlements.length, 2);
    assert.equal(detail?.canSettle, true);
  });

  it("rejects invalid outcomes, notes, and canceled receipts", async (t) => {
    useClock(t);
    await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028", { senderHandle: CONNOR_HANDLE });
    const receipt = await receiptId(1);
    await assert.rejects(app.mutation("settleReceipt", JR, receipt, "maybe" as "right", null), /Outcome/);
    await assert.rejects(app.mutation("settleReceipt", JR, receipt, "right", "x".repeat(501)), /Notes/);
    await app.chat("@receipts cancel 1", { senderHandle: CONNOR_HANDLE });
    await assert.rejects(app.mutation("settleReceipt", JR, receipt, "right", null), /canceled/);
  });
});

describe("who may settle", () => {
  it("lets anyone but the take's author settle, at any time", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts I say the Giants win by Oct 1 2027", { senderHandle: JR_HANDLE });
    const receipt = await receiptId(1);

    const mine = await app.query("receipt", JR, id, 1);
    assert.equal(mine?.canSettle, false);
    assert.match(mine?.settleBlockedReason ?? "", /can't settle your own take/);
    await assert.rejects(app.mutation("settleReceipt", JR, receipt, "right", null), /can't settle your own take/);

    assert.equal((await app.query("receipt", CONNOR, id, 1))?.canSettle, true);
    await app.mutation("settleReceipt", CONNOR, receipt, "wrong", "Missed the playoffs");
    assert.equal((await app.query("receipt", CONNOR, id, 1))?.card.status, "wrong");

    // Not even the owner may correct their own take.
    await assert.rejects(app.mutation("settleReceipt", JR, receipt, "right", null), /can't settle your own take/);
    const sarah = await app.query("receipt", SARAH, id, 1);
    assert.equal(sarah?.canSettle, false);
    assert.match(sarah?.settleBlockedReason ?? "", /group owner/);
  });

  it("names chat settlers in the history", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028", { senderHandle: JR_HANDLE });
    await app.chat("@receipts call me Sarah", { senderHandle: "+15555550555" });
    await app.chat("@receipts 1 right", { senderHandle: "+15555550555" });
    const detail = await app.query("receipt", JR, id, 1);
    assert.deepEqual(detail?.settlements.map((settlement) => settlement.settledByName), ["Sarah"]);
  });
});

describe("group, receipt, and profile views", () => {
  it("summarizes a group", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs before 2028");
    await app.chat("@receipts #take JR says the Giants win by Oct 10 2026");
    await app.chat("@receipts #promise Ben says he'll run a marathon");

    const group = await app.query("group", CONNOR, id);
    assert.ok(group);
    assert.equal(group.name, "The Boys");
    assert.equal(group.role, "member");
    assert.deepEqual(
      group.members.map(({ name, role, isMe }) => ({ name, role, isMe })),
      [
        { name: "Connor K", role: "member", isMe: true },
        { name: "JR Smith", role: "owner", isMe: false },
        { name: "Sarah P", role: "member", isMe: false }
      ]
    );
    assert.deepEqual(group.pending.map((card) => card.number), [3, 2, 1]);
    assert.deepEqual(group.dueSoon.map((card) => card.number), [2]);
    assert.deepEqual(group.recentlySettled, []);
    assert.deepEqual(
      group.standings.map((standing) => standing.subjectRef),
      ["n:connor", "n:jr"]
    );
    assert.deepEqual(group.pending[2], {
      id: await receiptId(1),
      groupId: id,
      number: 1,
      type: "take",
      status: "pending",
      capture: "manual",
      subjectRef: "n:connor",
      subjectName: "Connor",
      statement: "OpenAI IPOs",
      madeOn: "2026-09-25",
      deadline: "2028-01-01",
      dueAt: dueAtFor("2028-01-01", -420),
      heat: null,
      voteCount: 0,
      settledAt: null,
      nomination: null,
      callout: null,
      tempCheck: null
    });
    assert.deepEqual(group.nominations, []);
  });

  it("describes a receipt and its permissions", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Connor says OpenAI IPOs by 2028", { senderHandle: CONNOR_HANDLE });
    const detail = await app.query("receipt", SARAH, id, 1);
    assert.ok(detail);
    assert.equal(detail.groupName, "The Boys");
    assert.equal(detail.originalText, "@receipts #take Connor says OpenAI IPOs by 2028");
    assert.equal(detail.createdByName, maskHandle(CONNOR_HANDLE));
    assert.equal(detail.dateAmbiguous, true);
    assert.deepEqual(detail.votes, []);
    assert.equal(detail.myVote, null);
    assert.equal(detail.voteBlockedReason, null);
    assert.equal(detail.canSettle, true);
    assert.equal(detail.canEditDeadline, true);
    assert.equal(detail.canRespond, false);
    assert.equal(detail.settleBlockedReason, null);
    assert.deepEqual(detail.settlements, []);
    assert.equal(detail.points, null);
    assert.equal(await app.query("receipt", SARAH, id, 99), null);
  });

  it("hides canceled receipts", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2027");
    await app.chat("@receipts cancel 1");
    assert.equal(await app.query("receipt", JR, id, 1), null);
    assert.deepEqual((await app.query("group", JR, id))?.pending, []);
  });

  it("profiles unclaimed names and lets a member claim them", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take Sarah says the Giants win by Oct 1 2027");
    await app.chat("@receipts #bet Sarah says loser buys dinner if Nvidia is below $150 on Dec 31");
    await app.mutation("voteHeat", JR, await receiptId(1), 5);
    await app.mutation("settleReceipt", JR, await receiptId(1), "right", null);

    const profile = await app.query("profile", SARAH, id, "n:sarah");
    assert.ok(profile);
    assert.equal(profile.name, "Sarah");
    assert.equal(profile.claimable, true);
    assert.equal(profile.isMe, false);
    assert.equal(profile.standing.takeScore, 12);
    assert.equal(profile.hottestCorrect?.number, 1);
    assert.deepEqual(profile.bets.map((card) => card.number), [2]);
    assert.deepEqual(profile.currentTakes, []);
    assert.deepEqual(profile.recent.map((card) => card.number), [1]);

    assert.deepEqual(await app.mutation("claimName", SARAH, id, "n:sarah"), { subjectRef: "u:user-sarah" });
    assert.equal(await app.query("profile", SARAH, id, "n:sarah"), null);
    const mine = await app.query("profile", CONNOR, id, "u:user-sarah");
    assert.equal(mine?.name, "Sarah P");
    assert.equal(mine?.claimable, false);
    assert.equal(mine?.standing.takeScore, 12);
    assert.equal((await app.query("profile", SARAH, id, "u:user-sarah"))?.isMe, true);

    // New receipts about a claimed name link automatically.
    await app.chat("@receipts #take sarah says the Kings make the playoffs by April 20 2027");
    const latest = (await app.rows("receipts")).find((row) => row.number === 3);
    assert.equal(latest?.subjectUserId, "user-sarah");

    await assert.rejects(app.mutation("claimName", JR, id, "n:sarah"), /No unclaimed/);
    await assert.rejects(app.mutation("claimName", JR, id, "u:user-jr"), /chat name/);
  });
});

describe("editing", () => {
  it("sets deadlines and re-arms reminders", async (t) => {
    const clock = useClock(t);
    const id = await setUpGroup();
    await app.chat("@receipts #take JR says the Giants win by Oct 1 2026");
    const receipt = await receiptId(1);
    clock.now = dueAtFor("2026-10-01", -420) + DAY;
    await app.bot("POST", "/api/bot/reminded", { receiptId: receipt });

    await app.mutation("setDeadline", CONNOR, receipt, "2026-12-01");
    const [row] = await app.rows("receipts");
    assert.equal(row.deadline, "2026-12-01");
    assert.equal(row.dueAt, dueAtFor("2026-12-01", -420));
    assert.equal(row.remindedAt, undefined);
    assert.equal(row.dateAmbiguous, false);

    await app.mutation("setDeadline", CONNOR, receipt, null);
    const [cleared] = await app.rows("receipts");
    assert.equal(cleared.deadline, undefined);
    assert.equal(cleared.dueAt, undefined);

    await assert.rejects(app.mutation("setDeadline", CONNOR, receipt, "2026-02-30"), /date/);
    await app.mutation("settleReceipt", CONNOR, receipt, "void", null);
    await assert.rejects(app.mutation("setDeadline", CONNOR, receipt, "2026-12-01"), /pending/);
    assert.equal((await app.query("receipt", CONNOR, id, 1))?.canEditDeadline, false);
  });

  it("renames groups", async (t) => {
    useClock(t);
    const id = await setUpGroup();
    await app.mutation("renameGroup", SARAH, id, "  The Vault  ");
    assert.equal((await app.query("group", JR, id))?.name, "The Vault");
    await assert.rejects(app.mutation("renameGroup", SARAH, id, "   "), /name/);
    await assert.rejects(app.mutation("renameGroup", SARAH, id, "x".repeat(61)), /name/);
  });
});
