import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { BlueBubblesError } from "../src/bluebubbles";
import { BlueBubblesReplyResolver } from "../src/replies";
import { bbMessage, FakeBlueBubbles, GROUP } from "./fakes";

let bluebubbles: FakeBlueBubbles;
let resolver: BlueBubblesReplyResolver;

beforeEach(() => {
  bluebubbles = new FakeBlueBubbles();
  resolver = new BlueBubblesReplyResolver(bluebubbles);
});

describe("BlueBubblesReplyResolver", () => {
  it("resolves exactly the replied-to message", async () => {
    const source = bbMessage({ text: "No chance the Warriors finish below the 4 seed.", handle: { address: "+15555550999" } });
    bluebubbles.messages.push(source, bbMessage({ text: "unrelated chatter" }));
    const command = bbMessage({ text: "@receipts #take by Apr 15 2027", threadOriginatorGuid: source.guid });

    assert.deepEqual(await resolver.resolve(command), {
      messageGuid: source.guid,
      text: "No chance the Warriors finish below the 4 seed.",
      authorHandle: "+15555550999",
      sentAt: source.dateCreated,
      ambiguous: false
    });
    assert.deepEqual(bluebubbles.lookups, [source.guid]);
    assert.deepEqual(bluebubbles.threadQueries, [
      { chatGuid: GROUP, originatorGuid: source.guid, before: command.dateCreated, limit: 25 }
    ]);
  });

  it("marks a reply ambiguous when the thread already had other replies", async () => {
    const source = bbMessage({ text: "Warriors top 4" });
    const chatter = bbMessage({ text: "no shot", threadOriginatorGuid: source.guid });
    const command = bbMessage({ text: "@receipts #take by Apr 15 2027", threadOriginatorGuid: source.guid });
    bluebubbles.messages.push(source, chatter, command);
    assert.equal((await resolver.resolve(command))?.ambiguous, true);
  });

  it("ignores other @receipts replies, tapbacks, and later replies when judging a thread", async () => {
    const source = bbMessage({ text: "Warriors top 4" });
    const earlierCommand = bbMessage({ text: "@receipts #take by Apr 15 2027", threadOriginatorGuid: source.guid });
    const tapback = bbMessage({ text: "Loved “Warriors top 4”", threadOriginatorGuid: source.guid, associatedMessageType: "love", associatedMessageGuid: `p:0/${source.guid}` });
    const command = bbMessage({ text: "@receipts #take by May 1 2027", threadOriginatorGuid: source.guid });
    const later = bbMessage({ text: "lol", threadOriginatorGuid: source.guid });
    bluebubbles.messages.push(source, earlierCommand, tapback, command, later);
    assert.equal((await resolver.resolve(command))?.ambiguous, false);
  });

  it("throws when the thread lookup fails so the command is retried", async () => {
    const source = bbMessage({ text: "Warriors top 4" });
    bluebubbles.messages.push(source);
    bluebubbles.failThreadQueries = 1;
    await assert.rejects(resolver.resolve(bbMessage({ threadOriginatorGuid: source.guid })), BlueBubblesError);
  });

  it("returns null without a lookup when the command is not a reply", async () => {
    assert.equal(await resolver.resolve(bbMessage()), null);
    assert.deepEqual(bluebubbles.lookups, []);
  });

  it("returns null for sources that cannot be captured", async () => {
    const mine = bbMessage({ isFromMe: true, handle: null });
    const photo = bbMessage({ text: null });
    const blank = bbMessage({ text: "   " });
    bluebubbles.messages.push(mine, photo, blank);
    for (const guid of [mine.guid, photo.guid, blank.guid, "deleted-guid"]) {
      assert.equal(await resolver.resolve(bbMessage({ threadOriginatorGuid: guid })), null, guid);
    }
  });

  it("throws on transient lookup failures so the command is retried", async () => {
    bluebubbles.failLookups = 1;
    await assert.rejects(resolver.resolve(bbMessage({ threadOriginatorGuid: "anything" })), BlueBubblesError);
  });
});
