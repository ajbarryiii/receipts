import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MESSAGE_TEXT_LENGTH } from "../../app/shared/bot-api";
import { isGroupChat, toIncomingMessage } from "../src/filter";
import { bbMessage, DIRECT, GROUP } from "./fakes";

const options = { allowDirectChats: false, utcOffsetMinutes: () => -420 };

describe("isGroupChat", () => {
  it("recognizes group GUIDs and styles", () => {
    assert.equal(isGroupChat({ guid: GROUP }), true);
    assert.equal(isGroupChat({ guid: "SMS;+;chat99" }), true);
    assert.equal(isGroupChat({ guid: "iMessage;-;chat77", style: 43 }), true);
    assert.equal(isGroupChat({ guid: DIRECT }), false);
    assert.equal(isGroupChat({ guid: DIRECT, style: 45 }), false);
  });
});

describe("toIncomingMessage", () => {
  it("maps a group mention to the Lakebed payload", () => {
    const message = bbMessage({ text: "@receipts list" });
    assert.deepEqual(toIncomingMessage(message, options), {
      messageGuid: message.guid,
      chatGuid: GROUP,
      chatName: "The Boys",
      senderHandle: "+15555550123",
      text: "@receipts list",
      sentAt: message.dateCreated,
      utcOffsetMinutes: -420,
      replyTo: null
    });
  });

  it("forwards leading contact names without changing their text", () => {
    for (const text of ["receipts list", "Receipts list", "RECEIPTS list", "  Receipts: list", "Receipts, list", "Receipts"]) {
      assert.equal(toIncomingMessage(bbMessage({ text }), options)?.text, text);
    }
  });

  it("keeps ordinary receipts chatter and similar names on the Mac", () => {
    for (const text of ["send receipts please", "receiptsbot list", "receipts-bot list", "receipts_foo", "receipts.com", "receipts@example.com", "receiptsé list"]) {
      assert.equal(toIncomingMessage(bbMessage({ text }), options), null, text);
    }
  });

  it("uses a null chat name for unnamed groups", () => {
    const message = bbMessage({ chats: [{ guid: GROUP, displayName: "", style: 43 }] });
    assert.equal(toIncomingMessage(message, options)?.chatName, null);
  });

  it("asks for the offset at the time the message was sent", () => {
    const seen: number[] = [];
    const message = bbMessage();
    toIncomingMessage(message, { allowDirectChats: false, utcOffsetMinutes: (at) => (seen.push(at), -480) });
    assert.deepEqual(seen, [message.dateCreated]);
  });

  it("drops everything that must stay on the Mac", () => {
    const dropped = [
      bbMessage({ isFromMe: true }),
      bbMessage({ text: "no mention here" }),
      bbMessage({ text: null }),
      bbMessage({ text: "" }),
      bbMessage({ associatedMessageType: "like", associatedMessageGuid: "p:0/guid-1" }),
      bbMessage({ associatedMessageGuid: "p:0/guid-1" }),
      bbMessage({ itemType: 2 }),
      bbMessage({ handle: null }),
      bbMessage({ chats: [] }),
      bbMessage({ chats: undefined }),
      bbMessage({ chats: [{ guid: DIRECT, style: 45 }] })
    ];
    for (const message of dropped) {
      assert.equal(toIncomingMessage(message, options), null, JSON.stringify(message));
    }
  });

  it("forwards direct chats only when allowed", () => {
    const message = bbMessage({ chats: [{ guid: DIRECT, style: 45 }] });
    assert.equal(toIncomingMessage(message, { ...options, allowDirectChats: true })?.chatGuid, DIRECT);
  });

  it("truncates oversized text to the API limit", () => {
    const message = bbMessage({ text: `@receipts ${"x".repeat(MAX_MESSAGE_TEXT_LENGTH)}` });
    assert.equal(toIncomingMessage(message, options)?.text.length, MAX_MESSAGE_TEXT_LENGTH);
  });
});
