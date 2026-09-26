import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Bridge, type BridgeOptions } from "../src/bridge";
import { ReceiptsApiClient, ReceiptsApiError, type ReceiptsPort } from "../src/receipts-api";
import { MemoryStateStore } from "../src/state";
import { bbMessage, DIRECT, FakeBlueBubbles, FakeReceipts, GROUP, NOW, silentLogger } from "./fakes";

const HOUR = 60 * 60 * 1000;
const OPTIONS: BridgeOptions = { allowDirectChats: false, initialLookbackMs: 24 * HOUR, pageSize: 50, maxPagesPerScan: 5 };

let bluebubbles: FakeBlueBubbles;
let receipts: FakeReceipts;
let store: MemoryStateStore;

beforeEach(() => {
  bluebubbles = new FakeBlueBubbles();
  receipts = new FakeReceipts();
  store = new MemoryStateStore();
});

async function makeBridge(options: Partial<BridgeOptions> = {}, receiptsPort: ReceiptsPort = receipts): Promise<Bridge> {
  const bridge = new Bridge({
    bluebubbles,
    receipts: receiptsPort,
    store,
    clock: () => NOW,
    utcOffsetMinutes: () => -420,
    log: silentLogger(),
    options: { ...OPTIONS, ...options }
  });
  await bridge.start();
  return bridge;
}

describe("forwarding messages", () => {
  it("forwards a group mention, sends the reply, and acknowledges it", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    await bridge.handleMessage(message);

    assert.equal(receipts.submitted.length, 1);
    assert.equal(receipts.submitted[0].messageGuid, message.guid);
    assert.deepEqual(bluebubbles.sent, [{ chatGuid: GROUP, text: `🧾 got ${message.guid}` }]);
    assert.deepEqual(receipts.acked, [message.guid]);
    assert.deepEqual(store.saved?.pendingAcks, []);
    assert.ok(store.saved?.recentGuids.includes(message.guid));
  });

  it("keeps everything else on the Mac", async () => {
    const bridge = await makeBridge();
    for (const message of [
      bbMessage({ isFromMe: true }),
      bbMessage({ text: "just chatting" }),
      bbMessage({ associatedMessageType: "laugh", associatedMessageGuid: "p:0/x" }),
      bbMessage({ chats: [{ guid: DIRECT, style: 45 }] })
    ]) {
      await bridge.handleMessage(message);
    }
    assert.equal(receipts.submitted.length, 0);
    assert.equal(bluebubbles.sent.length, 0);
  });

  it("does not send anything when Lakebed has no reply", async () => {
    const bridge = await makeBridge();
    receipts.replyFor = () => null;
    const message = bbMessage();
    await bridge.handleMessage(message);
    assert.equal(bluebubbles.sent.length, 0);
    assert.deepEqual(receipts.acked, []);
    assert.ok(store.saved?.recentGuids.includes(message.guid));
  });

  it("handles each message once", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    await bridge.handleMessage(message);
    await bridge.handleMessage(message);
    assert.equal(receipts.submitted.length, 1);
    assert.equal(bluebubbles.sent.length, 1);
  });

  it("remembers handled messages across restarts", async () => {
    const message = bbMessage();
    await (await makeBridge()).handleMessage(message);
    await (await makeBridge()).handleMessage(message);
    assert.equal(receipts.submitted.length, 1);
  });

  it("retries a failed send using the reply Lakebed still holds", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    bluebubbles.failSends = 1;
    await bridge.handleMessage(message);
    assert.equal(bluebubbles.sent.length, 0);
    assert.deepEqual(receipts.acked, []);

    await bridge.handleMessage(message);
    assert.deepEqual(bluebubbles.sent, [{ chatGuid: GROUP, text: `🧾 got ${message.guid}` }]);
    assert.deepEqual(receipts.acked, [message.guid]);
  });

  it("never resends a reply when only the acknowledgement failed", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    receipts.failAcks = 1;
    await bridge.handleMessage(message);
    assert.equal(bluebubbles.sent.length, 1);
    assert.deepEqual(store.saved?.pendingAcks, [{ kind: "reply", messageGuid: message.guid }]);

    await bridge.handleMessage(message);
    await (await makeBridge()).handleMessage(message);
    assert.equal(bluebubbles.sent.length, 1);

    await bridge.flushAcks();
    assert.deepEqual(receipts.acked, [message.guid]);
    assert.deepEqual(store.saved?.pendingAcks, []);
  });

  it("moves past messages Lakebed permanently rejects", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    receipts.submitErrors.push(new ReceiptsApiError("bad payload", 400, false));
    await bridge.handleMessage(message);
    assert.ok(store.saved?.recentGuids.includes(message.guid));
  });

  it("caps the remembered GUID list", async () => {
    const bridge = await makeBridge();
    receipts.replyFor = () => null;
    for (let index = 0; index < 2005; index += 1) {
      await bridge.handleMessage(bbMessage());
    }
    assert.equal(store.saved?.recentGuids.length, 2000);
  });
});

describe("catch-up", () => {
  it("looks back from now on the first scan, then follows the ROWID cursor", async () => {
    const bridge = await makeBridge();
    const old = bbMessage({ dateCreated: NOW - 25 * HOUR });
    const chatter = bbMessage({ text: "lol" });
    const mention = bbMessage();
    bluebubbles.messages.push(old, chatter, mention);

    assert.deepEqual(await bridge.catchUp(), { scanned: 2, forwarded: 1, stoppedEarly: false });
    assert.deepEqual(bluebubbles.queries[0], { afterRowId: null, since: NOW - 24 * HOUR, limit: 50, offset: 0 });
    assert.deepEqual(receipts.submitted.map((message) => message.messageGuid), [mention.guid]);
    assert.equal(store.saved?.cursorRowId, mention.originalROWID);

    const later = bbMessage();
    bluebubbles.messages.push(later);
    await bridge.catchUp();
    assert.equal(bluebubbles.queries.at(-1)?.afterRowId, mention.originalROWID);
    assert.deepEqual(receipts.submitted.map((message) => message.messageGuid), [mention.guid, later.guid]);
    assert.equal(store.saved?.cursorRowId, later.originalROWID);
  });

  it("skips messages the webhook already forwarded", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    bluebubbles.messages.push(message);
    await bridge.handleMessage(message);
    await bridge.catchUp();
    assert.equal(receipts.submitted.length, 1);
    assert.equal(bluebubbles.sent.length, 1);
  });

  it("stops at a retryable failure and resumes from the last good message", async () => {
    const bridge = await makeBridge();
    const [first, second, third] = [bbMessage(), bbMessage(), bbMessage()];
    bluebubbles.messages.push(first, second, third);
    let calls = 0;
    const original = receipts.submitMessage.bind(receipts);
    receipts.submitMessage = async (message) => {
      calls += 1;
      if (calls === 2) throw new ReceiptsApiError("offline", null, true);
      return original(message);
    };

    assert.deepEqual(await bridge.catchUp(), { scanned: 1, forwarded: 1, stoppedEarly: true });
    assert.equal(store.saved?.cursorRowId, first.originalROWID);

    await bridge.catchUp();
    assert.deepEqual(
      receipts.submitted.map((message) => message.messageGuid),
      [first.guid, second.guid, third.guid]
    );
    assert.equal(store.saved?.cursorRowId, third.originalROWID);
  });

  it("pages through a backlog across scans", async () => {
    const bridge = await makeBridge({ pageSize: 2, maxPagesPerScan: 2 });
    const messages = [bbMessage(), bbMessage(), bbMessage(), bbMessage(), bbMessage()];
    bluebubbles.messages.push(...messages);

    const first = await bridge.catchUp();
    assert.equal(first.forwarded, 4);
    assert.equal(store.saved?.cursorRowId, messages[3].originalROWID);

    await bridge.catchUp();
    assert.equal(receipts.submitted.length, 5);
    assert.equal(store.saved?.cursorRowId, messages[4].originalROWID);
  });

  it("does not skip newer-dated messages when a delayed message has a larger ROWID", async () => {
    const bridge = await makeBridge({ pageSize: 2, maxPagesPerScan: 1 });
    const first = bbMessage({ dateCreated: NOW - 1000 });
    const second = bbMessage({ dateCreated: NOW - 500 });
    const delayed = bbMessage({ dateCreated: NOW - 5000 });
    bluebubbles.messages.push(first, second, delayed);

    assert.equal((await bridge.catchUp()).forwarded, 2);
    assert.equal(store.saved?.cursorRowId, second.originalROWID);
    assert.equal((await bridge.catchUp()).forwarded, 1);
    assert.deepEqual(receipts.submitted.map((message) => message.messageGuid), [first.guid, second.guid, delayed.guid]);
  });

  it("keeps commands and owed acknowledgements while bot credentials are being corrected", async () => {
    let allowMessages = false;
    let allowAcks = false;
    const api = new ReceiptsApiClient({
      baseUrl: "https://receipts.test",
      secret: "test-secret",
      fetch: (async (input) => {
        const isAck = String(input).endsWith("/ack");
        const allowed = isAck ? allowAcks : allowMessages;
        return new Response(JSON.stringify(allowed ? (isAck ? { ok: true } : { status: "processed", reply: "🧾 logged" }) : { error: "Unauthorized" }), {
          status: allowed ? 200 : 401,
          headers: { "Content-Type": "application/json" }
        });
      }) as typeof fetch
    });
    const bridge = await makeBridge({}, api);
    const message = bbMessage();
    bluebubbles.messages.push(message);

    assert.deepEqual(await bridge.catchUp(), { scanned: 0, forwarded: 0, stoppedEarly: true });
    assert.equal(store.saved?.cursorRowId, null);
    assert.deepEqual(store.saved?.recentGuids, []);

    allowMessages = true;
    assert.equal((await bridge.catchUp()).forwarded, 1);
    await bridge.flushAcks();
    assert.deepEqual(store.saved?.pendingAcks, [{ kind: "reply", messageGuid: message.guid }]);

    allowAcks = true;
    await bridge.flushAcks();
    assert.deepEqual(store.saved?.pendingAcks, []);
    assert.equal(bluebubbles.sent.length, 1);
  });

  it("survives BlueBubbles being unavailable", async () => {
    const bridge = await makeBridge();
    bluebubbles.failQueries = 1;
    assert.deepEqual(await bridge.catchUp(), { scanned: 0, forwarded: 0, stoppedEarly: true });
    assert.equal(store.saved?.cursorRowId ?? null, null);
  });
});

describe("reminders", () => {
  beforeEach(() => {
    receipts.due = [
      { receiptId: "r1", chatGuid: GROUP, message: "🚨 RECEIPT DUE one" },
      { receiptId: "r2", chatGuid: GROUP, message: "🚨 RECEIPT DUE two" }
    ];
  });

  it("sends due reminders and acknowledges each", async () => {
    const bridge = await makeBridge();
    assert.deepEqual(await bridge.deliverReminders(), { sent: 2, failed: 0 });
    assert.deepEqual(
      bluebubbles.sent.map((sent) => sent.text),
      ["🚨 RECEIPT DUE one", "🚨 RECEIPT DUE two"]
    );
    assert.deepEqual(receipts.reminded, ["r1", "r2"]);
    assert.deepEqual(await bridge.deliverReminders(), { sent: 0, failed: 0 });
  });

  it("does not mark a reminder until the send succeeds", async () => {
    const bridge = await makeBridge();
    bluebubbles.failSends = 1;
    assert.deepEqual(await bridge.deliverReminders(), { sent: 1, failed: 1 });
    assert.deepEqual(receipts.reminded, ["r2"]);
    assert.deepEqual(await bridge.deliverReminders(), { sent: 1, failed: 0 });
    assert.deepEqual(receipts.reminded, ["r2", "r1"]);
  });

  it("never resends a reminder whose acknowledgement failed, even after a restart", async () => {
    receipts.failReminded = 1;
    await (await makeBridge()).deliverReminders();
    assert.equal(bluebubbles.sent.length, 2);
    assert.deepEqual(store.saved?.pendingAcks, [{ kind: "reminder", receiptId: "r1" }]);

    const restarted = await makeBridge();
    await restarted.deliverReminders();
    assert.equal(bluebubbles.sent.length, 2);
    assert.deepEqual(receipts.reminded.sort(), ["r1", "r2"]);
    assert.deepEqual(store.saved?.pendingAcks, []);
  });

  it("keeps an unacknowledged reminder pending while Lakebed stays unreachable", async () => {
    receipts.failReminded = 5;
    const bridge = await makeBridge();
    await bridge.deliverReminders();
    await bridge.deliverReminders();
    assert.equal(bluebubbles.sent.length, 2);
  });
});

describe("announcements", () => {
  beforeEach(() => {
    receipts.announcements = [
      { announcementId: "a1", chatGuid: GROUP, message: "⏰ TAKE BLITZ OVER" },
      { announcementId: "a2", chatGuid: GROUP, message: "👑 CROWN STOLEN." }
    ];
  });

  it("sends announcements and acknowledges each", async () => {
    const bridge = await makeBridge();
    assert.deepEqual(await bridge.deliverAnnouncements(), { sent: 2, failed: 0 });
    assert.deepEqual(
      bluebubbles.sent.map((sent) => sent.text),
      ["⏰ TAKE BLITZ OVER", "👑 CROWN STOLEN."]
    );
    assert.deepEqual(receipts.announced, ["a1", "a2"]);
    assert.deepEqual(await bridge.deliverAnnouncements(), { sent: 0, failed: 0 });
  });

  it("does not acknowledge an announcement until the send succeeds", async () => {
    const bridge = await makeBridge();
    bluebubbles.failSends = 1;
    assert.deepEqual(await bridge.deliverAnnouncements(), { sent: 1, failed: 1 });
    assert.deepEqual(receipts.announced, ["a2"]);
    assert.deepEqual(await bridge.deliverAnnouncements(), { sent: 1, failed: 0 });
    assert.deepEqual(receipts.announced, ["a2", "a1"]);
  });

  it("never resends an announcement whose acknowledgement failed, even after a restart", async () => {
    receipts.failAnnounced = 1;
    await (await makeBridge()).deliverAnnouncements();
    assert.equal(bluebubbles.sent.length, 2);
    assert.deepEqual(store.saved?.pendingAcks, [{ kind: "announcement", announcementId: "a1" }]);

    const restarted = await makeBridge();
    await restarted.deliverAnnouncements();
    assert.equal(bluebubbles.sent.length, 2);
    assert.deepEqual(receipts.announced.sort(), ["a1", "a2"]);
    assert.deepEqual(store.saved?.pendingAcks, []);
  });

  it("goes out with every sync", async () => {
    const bridge = await makeBridge();
    await bridge.sync();
    assert.deepEqual(receipts.announced, ["a1", "a2"]);
  });

  it("survives Lakebed being unreachable", async () => {
    receipts.fetchAnnouncements = async () => {
      throw new ReceiptsApiError("Receipts unreachable", null, true);
    };
    const bridge = await makeBridge();
    assert.deepEqual(await bridge.deliverAnnouncements(), { sent: 0, failed: 0 });
  });
});

describe("webhooks and sync", () => {
  it("forwards new-message webhooks", async () => {
    const bridge = await makeBridge();
    const message = bbMessage();
    await bridge.handleWebhook({ type: "new-message", data: message });
    assert.deepEqual(receipts.submitted.map((submitted) => submitted.messageGuid), [message.guid]);
  });

  it("syncs when BlueBubbles restarts", async () => {
    const bridge = await makeBridge();
    const missed = bbMessage();
    bluebubbles.messages.push(missed);
    receipts.due = [{ receiptId: "r1", chatGuid: GROUP, message: "🚨 due" }];
    await bridge.handleWebhook({ type: "hello-world", data: null });
    assert.deepEqual(receipts.submitted.map((submitted) => submitted.messageGuid), [missed.guid]);
    assert.deepEqual(receipts.reminded, ["r1"]);
  });

  it("ignores other and malformed webhook bodies", async () => {
    const bridge = await makeBridge();
    for (const payload of [null, "text", [], { type: "typing-indicator", data: {} }, { type: "new-message" }, { type: "new-message", data: 5 }]) {
      await bridge.handleWebhook(payload);
    }
    assert.equal(receipts.submitted.length, 0);
  });

  it("flushes owed acknowledgements before scanning", async () => {
    store = new MemoryStateStore({
      version: 1,
      cursorRowId: null,
      recentGuids: ["guid-owed"],
      pendingAcks: [{ kind: "reply", messageGuid: "guid-owed" }]
    });
    const bridge = await makeBridge();
    await bridge.sync();
    assert.deepEqual(receipts.acked, ["guid-owed"]);
  });

  it("runs one operation at a time", async () => {
    const bridge = await makeBridge();
    bluebubbles.sendDelayMs = 5;
    bluebubbles.messages.push(bbMessage(), bbMessage());
    receipts.due = [{ receiptId: "r1", chatGuid: GROUP, message: "🚨 due" }];
    await Promise.all([bridge.handleMessage(bbMessage()), bridge.catchUp(), bridge.deliverReminders(), bridge.sync()]);
    assert.equal(bluebubbles.maxInFlightSends, 1);
    assert.equal(bluebubbles.sent.length, 4);
  });
});

describe("reply-based commands", () => {
  it("sends the command with only the replied-to message attached", async () => {
    const bridge = await makeBridge();
    const source = bbMessage({ text: "No chance the Warriors finish below the 4 seed.", handle: { address: "+15555550999" } });
    const chatter = bbMessage({ text: "lol" });
    bluebubbles.messages.push(source, chatter);
    const command = bbMessage({ text: "@receipts #take by Apr 15 2027", threadOriginatorGuid: source.guid });

    await bridge.handleMessage(command);
    assert.equal(receipts.submitted.length, 1);
    assert.deepEqual(receipts.submitted[0].replyTo, {
      messageGuid: source.guid,
      text: "No chance the Warriors finish below the 4 seed.",
      authorHandle: "+15555550999",
      sentAt: source.dateCreated,
      ambiguous: false
    });
    assert.deepEqual(bluebubbles.lookups, [source.guid]);
    assert.equal(JSON.stringify(receipts.submitted).includes("lol"), false);
  });

  it("flags replies inside busy threads without forwarding the thread", async () => {
    const bridge = await makeBridge();
    const source = bbMessage({ text: "Warriors top 4" });
    const chatter = bbMessage({ text: "no shot bro", threadOriginatorGuid: source.guid });
    bluebubbles.messages.push(source, chatter);
    await bridge.handleMessage(bbMessage({ text: "@receipts #take by Apr 15 2027", threadOriginatorGuid: source.guid }));
    assert.equal(receipts.submitted[0].replyTo?.ambiguous, true);
    assert.equal(JSON.stringify(receipts.submitted).includes("no shot"), false);
  });

  it("never looks up sources for messages that do not mention the bot", async () => {
    const bridge = await makeBridge();
    const source = bbMessage();
    bluebubbles.messages.push(source);
    await bridge.handleMessage(bbMessage({ text: "haha true", threadOriginatorGuid: source.guid }));
    assert.deepEqual(bluebubbles.lookups, []);
    assert.equal(receipts.submitted.length, 0);
  });

  it("retries later when the source lookup fails", async () => {
    const bridge = await makeBridge();
    const source = bbMessage({ text: "Giants in 5" });
    bluebubbles.messages.push(source);
    const command = bbMessage({ text: "@receipts #take by Oct 1 2027", threadOriginatorGuid: source.guid });
    bluebubbles.failLookups = 1;

    await bridge.handleMessage(command);
    assert.equal(receipts.submitted.length, 0);
    await bridge.handleMessage(command);
    assert.equal(receipts.submitted[0].replyTo?.text, "Giants in 5");
  });

  it("recovers reply commands missed while offline", async () => {
    const bridge = await makeBridge();
    const source = bbMessage({ text: "No chance the Warriors finish below the 4 seed." });
    const command = bbMessage({ text: "@receipts #take by Apr 15 2027", threadOriginatorGuid: source.guid });
    bluebubbles.messages.push(source, command);

    await bridge.catchUp();
    assert.deepEqual(
      receipts.submitted.map((message) => [message.messageGuid, message.replyTo?.messageGuid]),
      [[command.guid, source.guid]]
    );
    assert.equal(bluebubbles.sent.length, 1);
  });

  it("forwards replies to the bot's own messages as plain commands", async () => {
    const bridge = await makeBridge();
    const botMessage = bbMessage({ isFromMe: true, handle: null, text: "🧾 TAKE NOMINATED" });
    bluebubbles.messages.push(botMessage);
    await bridge.handleMessage(bbMessage({ text: "@receipts accept 1", threadOriginatorGuid: botMessage.guid }));
    assert.equal(receipts.submitted[0].replyTo, null);
    assert.equal(receipts.submitted[0].text, "@receipts accept 1");
  });
});
