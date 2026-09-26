// HTTP contract between the Mac bridge and the Lakebed app.
// Every route requires `Authorization: Bearer <RECEIPTS_BOT_SECRET>`.
// Keep this file free of imports: the bridge bundles it directly.

export const BOT_ROUTES = {
  /** GET → PingResponse. Cheap authenticated health check. */
  ping: "/api/bot/ping",
  /** POST IncomingMessage → IncomingMessageResult. Idempotent on `messageGuid`. */
  message: "/api/bot/message",
  /** POST MessageAck → OkResponse. Call after the reply was handed to iMessage. Idempotent. */
  messageAck: "/api/bot/message/ack",
  /** GET → DueResponse. Pending receipts whose deadline passed and whose reminder was not acknowledged. */
  due: "/api/bot/due",
  /** POST RemindedRequest → OkResponse. Call after the reminder was handed to iMessage. Idempotent. */
  reminded: "/api/bot/reminded",
  /** GET → AnnouncementsResponse. Group announcements (Take Blitz news) ready to send, oldest first. */
  announcements: "/api/bot/announcements",
  /** POST AnnouncedRequest → OkResponse. Call after the announcement was handed to iMessage. Idempotent. */
  announced: "/api/bot/announced"
} as const;

export const MAX_MESSAGE_TEXT_LENGTH = 2000;

/**
 * The message an "@receipts" command replied to with native iMessage Reply.
 * The bridge resolves exactly this one message locally; nothing else from the chat is sent.
 */
export type ReplySource = {
  messageGuid: string;
  /** Exact text of the replied-to message. */
  text: string;
  /** Author's phone number or email. Stored privately; never shown on the web. */
  authorHandle: string;
  /** When the replied-to message was sent, epoch ms. */
  sentAt: number;
  /**
   * True when the command was sent inside a reply thread that already had other replies.
   * iMessage only records a thread's first message, so the message the sender meant is unknown
   * and Lakebed must ask for the take to be spelled out instead of capturing `text`.
   */
  ambiguous: boolean;
};

export type IncomingMessage = {
  /** iMessage/BlueBubbles message GUID. The idempotency key. */
  messageGuid: string;
  /** Conversation GUID used to send replies and reminders. */
  chatGuid: string;
  /** Group display name, when the chat has one. */
  chatName: string | null;
  /** Sender phone number or email. Stored privately; never shown on the web. */
  senderHandle: string;
  text: string;
  /** When the message was sent, epoch ms. */
  sentAt: number;
  /** Bridge host's UTC offset in minutes at `sentAt` (e.g. -420 for PDT). */
  utcOffsetMinutes: number;
  /** Set when the command is a native reply to someone's message; null otherwise. */
  replyTo: ReplySource | null;
};

export type IncomingMessageResult = {
  /**
   * processed: handled now. duplicate: handled before. ignored: nothing for Receipts to do.
   */
  status: "processed" | "duplicate" | "ignored";
  /** Text to send into `chatGuid`, then acknowledge. Null means send nothing. */
  reply: string | null;
};

export type MessageAck = {
  messageGuid: string;
};

export type DueReminder = {
  receiptId: string;
  chatGuid: string;
  message: string;
};

export type DueResponse = {
  reminders: DueReminder[];
};

export type RemindedRequest = {
  receiptId: string;
};

/** A message Lakebed wants posted into a group on its own, not in reply to anything. */
export type DueAnnouncement = {
  announcementId: string;
  chatGuid: string;
  message: string;
};

export type AnnouncementsResponse = {
  announcements: DueAnnouncement[];
};

export type AnnouncedRequest = {
  announcementId: string;
};

export type PingResponse = {
  ok: true;
  now: number;
};

export type OkResponse = {
  ok: true;
};

export type ErrorResponse = {
  error: string;
};

export class BotApiValidationError extends Error {}

/** Validates an untrusted IncomingMessage payload. Throws BotApiValidationError. */
export function parseIncomingMessage(value: unknown): IncomingMessage {
  const record = requireRecord(value);
  const text = requireString(record, "text", MAX_MESSAGE_TEXT_LENGTH, true);
  const chatName = record.chatName;
  if (chatName !== null && chatName !== undefined && typeof chatName !== "string") {
    throw new BotApiValidationError("chatName must be a string or null.");
  }
  const sentAt = requireTimestamp(record, "sentAt");
  const utcOffsetMinutes = record.utcOffsetMinutes;
  if (
    typeof utcOffsetMinutes !== "number" ||
    !Number.isInteger(utcOffsetMinutes) ||
    utcOffsetMinutes < -14 * 60 ||
    utcOffsetMinutes > 14 * 60
  ) {
    throw new BotApiValidationError("utcOffsetMinutes must be an integer between -840 and 840.");
  }
  return {
    messageGuid: requireString(record, "messageGuid", 200),
    chatGuid: requireString(record, "chatGuid", 300),
    chatName: typeof chatName === "string" && chatName.trim() ? chatName.trim().slice(0, 100) : null,
    senderHandle: requireString(record, "senderHandle", 200),
    text,
    sentAt,
    utcOffsetMinutes,
    replyTo: record.replyTo === undefined || record.replyTo === null ? null : parseReplySource(record.replyTo)
  };
}

function parseReplySource(value: unknown): ReplySource {
  const record = requireRecord(value);
  return {
    messageGuid: requireString(record, "messageGuid", 200),
    text: requireString(record, "text", MAX_MESSAGE_TEXT_LENGTH),
    authorHandle: requireString(record, "authorHandle", 200),
    sentAt: requireTimestamp(record, "sentAt"),
    ambiguous: requireOptionalBoolean(record, "ambiguous")
  };
}

function requireOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new BotApiValidationError(`${key} must be a boolean.`);
  }
  return value;
}

export function parseMessageAck(value: unknown): MessageAck {
  const record = requireRecord(value);
  return { messageGuid: requireString(record, "messageGuid", 200) };
}

export function parseRemindedRequest(value: unknown): RemindedRequest {
  const record = requireRecord(value);
  return { receiptId: requireString(record, "receiptId", 200) };
}

/** Validates an untrusted AnnouncedRequest payload. Throws BotApiValidationError. */
export function parseAnnouncedRequest(value: unknown): AnnouncedRequest {
  const record = requireRecord(value);
  return { announcementId: requireString(record, "announcementId", 200) };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BotApiValidationError("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requireTimestamp(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BotApiValidationError(`${key} must be epoch milliseconds.`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, maxLength: number, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new BotApiValidationError(`${key} must be a string.`);
  }
  if (!allowEmpty && !value.trim()) {
    throw new BotApiValidationError(`${key} must not be empty.`);
  }
  if (value.length > maxLength) {
    throw new BotApiValidationError(`${key} must be at most ${maxLength} characters.`);
  }
  return value;
}
