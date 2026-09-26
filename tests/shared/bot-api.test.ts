import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BotApiValidationError, parseAnnouncedRequest, parseIncomingMessage, parseMessageAck, parseRemindedRequest } from "../../app/shared/bot-api";

const valid = {
  messageGuid: "msg-1",
  chatGuid: "iMessage;+;chat123",
  chatName: " The Boys ",
  senderHandle: "+15555550123",
  text: "@receipts list",
  sentAt: 1790000000000,
  utcOffsetMinutes: -420
};

describe("parseIncomingMessage", () => {
  it("accepts a valid payload and trims the chat name", () => {
    assert.deepEqual(parseIncomingMessage(valid), { ...valid, chatName: "The Boys", replyTo: null });
  });

  it("accepts a resolved reply source", () => {
    const replyTo = { messageGuid: "src-1", text: "No chance the Warriors finish below the 4 seed.", authorHandle: "+15555550999", sentAt: 1789990000000 };
    assert.deepEqual(parseIncomingMessage({ ...valid, replyTo }).replyTo, { ...replyTo, ambiguous: false });
    assert.deepEqual(parseIncomingMessage({ ...valid, replyTo: { ...replyTo, ambiguous: true } }).replyTo, { ...replyTo, ambiguous: true });
    assert.equal(parseIncomingMessage({ ...valid, replyTo: null }).replyTo, null);
  });

  it("rejects malformed reply sources", () => {
    const source = { messageGuid: "src-1", text: "hi", authorHandle: "+15555550999", sentAt: 1789990000000 };
    for (const replyTo of [
      "src-1",
      { ...source, messageGuid: "" },
      { ...source, text: "" },
      { ...source, text: "x".repeat(2001) },
      { ...source, authorHandle: 5 },
      { ...source, sentAt: "then" },
      { ...source, ambiguous: "yes" }
    ]) {
      assert.throws(() => parseIncomingMessage({ ...valid, replyTo }), BotApiValidationError, JSON.stringify(replyTo));
    }
  });

  it("normalizes a missing or blank chat name to null", () => {
    assert.equal(parseIncomingMessage({ ...valid, chatName: undefined }).chatName, null);
    assert.equal(parseIncomingMessage({ ...valid, chatName: "  " }).chatName, null);
  });

  it("rejects malformed payloads", () => {
    const bad: unknown[] = [
      null,
      [],
      "text",
      { ...valid, messageGuid: "" },
      { ...valid, chatGuid: 5 },
      { ...valid, senderHandle: undefined },
      { ...valid, text: 42 },
      { ...valid, text: "x".repeat(2001) },
      { ...valid, sentAt: "yesterday" },
      { ...valid, sentAt: Number.NaN },
      { ...valid, utcOffsetMinutes: 30.5 },
      { ...valid, utcOffsetMinutes: 900 },
      { ...valid, chatName: 7 }
    ];
    for (const value of bad) {
      assert.throws(() => parseIncomingMessage(value), BotApiValidationError, JSON.stringify(value));
    }
  });
});

describe("ack payloads", () => {
  it("validates message acks and reminder acks", () => {
    assert.deepEqual(parseMessageAck({ messageGuid: "m" }), { messageGuid: "m" });
    assert.deepEqual(parseRemindedRequest({ receiptId: "r" }), { receiptId: "r" });
    assert.throws(() => parseMessageAck({}), BotApiValidationError);
    assert.throws(() => parseRemindedRequest({ receiptId: "" }), BotApiValidationError);
  });
});

describe("announcement acks", () => {
  it("validates announcement acks", () => {
    assert.deepEqual(parseAnnouncedRequest({ announcementId: "a" }), { announcementId: "a" });
    assert.throws(() => parseAnnouncedRequest({}), BotApiValidationError);
    assert.throws(() => parseAnnouncedRequest({ announcementId: "" }), BotApiValidationError);
    assert.throws(() => parseAnnouncedRequest(null), BotApiValidationError);
  });
});
