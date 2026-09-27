import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { account, CONNOR_HANDLE, JR_HANDLE, OTHER_CHAT, TestApp, tokenFrom } from "./harness";

let app: TestApp;
beforeEach(() => { app = new TestApp(); });
const VOTER = account("voter", "Connor");
async function take() {
  await app.chat("Receipts #take I say the Giants win by Oct 1 2027");
  return (await app.rows("receipts"))[0];
}
async function vote(fires = "🔥🔥", overrides = {}) {
  return app.chat(`Receipts 1 ${fires}`, { senderHandle: CONNOR_HANDLE, ...overrides });
}
async function joinWeb() {
  const token = tokenFrom((await app.chat("Receipts setup")).reply);
  return app.mutation("redeemInvite", VOTER, token);
}
async function link() {
  const token = tokenFrom((await app.chat("Receipts join", { senderHandle: CONNOR_HANDLE })).reply);
  return app.mutation("redeemInvite", VOTER, token);
}

describe("chat heat votes", () => {
  it("rates immediately, updates one vote, and deduplicates message retries", async () => {
    await take();
    const first = await vote();
    assert.match(first.reply ?? "", /your vote is 🔥🔥\. Group heat: 🔥🔥\./);
    await vote("🔥🔥🔥", { messageGuid: first.messageGuid });
    assert.equal((await app.rows("heatVotes"))[0].flames, 2);
    await vote("🔥🔥🔥🔥");
    const votes = await app.rows("heatVotes");
    assert.equal(votes.length, 1);
    assert.equal(votes[0].flames, 4);
    assert.equal(votes[0].userId, undefined);
    assert.ok(votes[0].identityId);
    await app.chat("@receipts 1 🔥🔥", { senderHandle: "+15555550000" });
    const receipt = (await app.rows("receipts"))[0];
    assert.equal(receipt.heat, 3);
    assert.equal(receipt.voteCount, 2);
  });

  it("displays unlinked voters on the website and shares votes after linking", async () => {
    const receipt = await take();
    await app.chat("Receipts call me Ace", { senderHandle: CONNOR_HANDLE });
    await vote();
    const { groupId } = await joinWeb();
    const before = await app.query("receipt", VOTER, groupId, 1);
    assert.deepEqual(before?.votes, [{ name: "Ace", flames: 2, isMine: false }]);
    await link();
    assert.equal((await app.query("receipt", VOTER, groupId, 1))?.myVote, 2);
    await app.mutation("voteHeat", VOTER, receipt.id as string, 5);
    await vote("🔥🔥🔥");
    assert.equal((await app.rows("heatVotes")).length, 1);
    assert.equal((await app.query("receipt", VOTER, groupId, 1))?.myVote, 3);
  });

  it("merges existing chat and web votes, keeping the latest", async (t) => {
    let now = Date.UTC(2026, 8, 27);
    t.mock.method(Date, "now", () => now);
    const receipt = await take();
    await joinWeb();
    await app.mutation("voteHeat", VOTER, receipt.id as string, 5);
    now += 1000;
    await vote();
    await link();
    assert.equal((await app.rows("heatVotes")).length, 1);
    assert.equal((await app.rows("heatVotes"))[0].flames, 2);
    assert.equal((await app.rows("receipts"))[0].heat, 2);
    await link();
    assert.equal((await app.rows("heatVotes")).length, 1);
  });

  it("keeps newer web votes and preserves frozen heat when linking after settlement", async (t) => {
    let now = Date.UTC(2026, 8, 27);
    t.mock.method(Date, "now", () => now);
    const receipt = await take();
    await vote();
    await joinWeb();
    now += 1000;
    await app.mutation("voteHeat", VOTER, receipt.id as string, 5);
    await app.chat("Receipts 1 right", { senderHandle: CONNOR_HANDLE });
    assert.equal((await app.rows("receipts"))[0].heat, 4);
    await link();
    assert.equal((await app.rows("heatVotes")).length, 1);
    assert.equal((await app.rows("heatVotes"))[0].flames, 5);
    assert.equal((await app.rows("receipts"))[0].heat, 4);
  });

  it("removes a web self-vote revealed by linking the author's chat identity", async () => {
    const receipt = await take();
    await joinWeb();
    await app.mutation("voteHeat", VOTER, receipt.id as string, 5);
    await app.mutation("redeemInvite", VOTER, tokenFrom((await app.chat("Receipts join")).reply));
    assert.equal((await app.rows("heatVotes")).length, 0);
    assert.equal((await app.rows("receipts"))[0].heat ?? null, null);
  });

  it("rejects self votes before and after linking", async () => {
    await take();
    assert.match((await vote("🔥", { senderHandle: JR_HANDLE })).reply ?? "", /your own take/);
    const author = account("author");
    await app.mutation("redeemInvite", author, tokenFrom((await app.chat("Receipts join")).reply));
    assert.match((await vote("🔥", { senderHandle: JR_HANDLE })).reply ?? "", /your own take/);
    assert.equal((await app.rows("heatVotes")).length, 0);
  });

  it("checks group scope, type, nomination state, cancellation, deadline, and settlement", async (t) => {
    let now = Date.UTC(2026, 8, 27);
    t.mock.method(Date, "now", () => now);
    await take();
    assert.match((await vote("🔥", { chatGuid: OTHER_CHAT })).reply ?? "", /No receipt/);
    await app.chat("Receipts #promise I will run a marathon");
    assert.match((await app.chat("Receipts 2 🔥", { senderHandle: CONNOR_HANDLE })).reply ?? "", /Only takes/);
    await app.reply("Receipts #take by Oct 1 2027", { text: "Warriors win", authorHandle: CONNOR_HANDLE });
    assert.match((await app.chat("Receipts 3 🔥")).reply ?? "", /Voting opens/);
    await app.chat("Receipts reject 3", { senderHandle: CONNOR_HANDLE });
    assert.match((await app.chat("Receipts 3 🔥")).reply ?? "", /Declined/);
    await app.chat("Receipts #take I say the Warriors win");
    await app.chat("Receipts cancel 4");
    assert.match((await app.chat("Receipts 4 🔥", { senderHandle: CONNOR_HANDLE })).reply ?? "", /canceled/);
    await app.chat("Receipts #take I say it rains tomorrow");
    await app.chat("Receipts 5 wrong", { senderHandle: CONNOR_HANDLE });
    assert.match((await app.chat("Receipts 5 🔥", { senderHandle: CONNOR_HANDLE })).reply ?? "", /Voting closed/);
    now = Date.UTC(2027, 9, 3);
    assert.match((await vote()).reply ?? "", /deadline/);
    assert.equal((await app.rows("heatVotes")).length, 0);
  });
});
