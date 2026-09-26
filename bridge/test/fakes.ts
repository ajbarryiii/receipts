import type { DueAnnouncement, DueReminder, IncomingMessage, IncomingMessageResult, PingResponse } from "../../app/shared/bot-api";
import { BlueBubblesError, type BBMessage, type BlueBubblesPort, type MessageQuery } from "../src/bluebubbles";
import type { Logger } from "../src/bridge";
import { ReceiptsApiError, type ReceiptsPort } from "../src/receipts-api";

export const GROUP = "iMessage;+;chat-boys";
export const DIRECT = "iMessage;-;+15555550999";
export const NOW = Date.UTC(2026, 8, 25, 19, 0);

let rowId = 0;

export function bbMessage(overrides: Partial<BBMessage> = {}): BBMessage {
  rowId += 1;
  return {
    guid: `guid-${rowId}`,
    originalROWID: rowId,
    text: `@receipts #take JR says take ${rowId} lands by Oct 1 2027`,
    isFromMe: false,
    dateCreated: NOW - 60_000 + rowId,
    handle: { address: "+15555550123" },
    chats: [{ guid: GROUP, displayName: "The Boys", style: 43 }],
    associatedMessageGuid: null,
    associatedMessageType: null,
    itemType: 0,
    threadOriginatorGuid: null,
    ...overrides
  };
}

/** Behaves like chat.db behind the BlueBubbles REST API. */
export class FakeBlueBubbles implements BlueBubblesPort {
  messages: BBMessage[] = [];
  sent: { chatGuid: string; text: string }[] = [];
  queries: MessageQuery[] = [];
  failSends = 0;
  failQueries = 0;
  failLookups = 0;
  lookups: string[] = [];
  failThreadQueries = 0;
  threadQueries: { chatGuid: string; originatorGuid: string; before: number; limit: number }[] = [];
  sendDelayMs = 0;
  inFlightSends = 0;
  maxInFlightSends = 0;

  async ping(): Promise<void> {}

  async queryMessages(query: MessageQuery): Promise<BBMessage[]> {
    this.queries.push(query);
    if (this.failQueries > 0) {
      this.failQueries -= 1;
      throw new BlueBubblesError("BlueBubbles is down", null);
    }
    return this.messages
      .filter((message) =>
        query.afterRowId === null ? message.dateCreated >= query.since : (message.originalROWID ?? 0) > query.afterRowId
      )
      .sort((a, b) => (a.originalROWID ?? 0) - (b.originalROWID ?? 0))
      .slice(query.offset, query.offset + query.limit);
  }

  async getMessage(guid: string): Promise<BBMessage | null> {
    this.lookups.push(guid);
    if (this.failLookups > 0) {
      this.failLookups -= 1;
      throw new BlueBubblesError("BlueBubbles is down", null);
    }
    return this.messages.find((message) => message.guid === guid) ?? null;
  }

  async threadReplies(chatGuid: string, originatorGuid: string, before: number, limit: number): Promise<BBMessage[]> {
    this.threadQueries.push({ chatGuid, originatorGuid, before, limit });
    if (this.failThreadQueries > 0) {
      this.failThreadQueries -= 1;
      throw new BlueBubblesError("BlueBubbles is down", null);
    }
    return this.messages
      .filter(
        (message) =>
          message.threadOriginatorGuid === originatorGuid &&
          message.chats?.some((chat) => chat.guid === chatGuid) &&
          message.dateCreated <= before
      )
      .sort((a, b) => a.dateCreated - b.dateCreated)
      .slice(0, limit);
  }

  async sendText(chatGuid: string, text: string): Promise<void> {
    this.inFlightSends += 1;
    this.maxInFlightSends = Math.max(this.maxInFlightSends, this.inFlightSends);
    try {
      if (this.sendDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
      }
      if (this.failSends > 0) {
        this.failSends -= 1;
        throw new BlueBubblesError("AppleScript failed", 500);
      }
      this.sent.push({ chatGuid, text });
    } finally {
      this.inFlightSends -= 1;
    }
  }
}

/** Mirrors Lakebed's contract: one processing per GUID, reply repeated until acknowledged. */
export class FakeReceipts implements ReceiptsPort {
  submitted: IncomingMessage[] = [];
  acked: string[] = [];
  reminded: string[] = [];
  due: DueReminder[] = [];
  announced: string[] = [];
  announcements: DueAnnouncement[] = [];
  ledger = new Map<string, { reply: string | null }>();
  submitErrors: ReceiptsApiError[] = [];
  failAcks = 0;
  failReminded = 0;
  failAnnounced = 0;
  replyFor: (message: IncomingMessage) => string | null = (message) => `🧾 got ${message.messageGuid}`;

  async ping(): Promise<PingResponse> {
    return { ok: true, now: NOW };
  }

  async submitMessage(message: IncomingMessage): Promise<IncomingMessageResult> {
    const error = this.submitErrors.shift();
    if (error) throw error;
    this.submitted.push(message);
    const existing = this.ledger.get(message.messageGuid);
    if (existing) {
      return { status: "duplicate", reply: existing.reply };
    }
    const reply = this.replyFor(message);
    this.ledger.set(message.messageGuid, { reply });
    return { status: "processed", reply };
  }

  async ackReply(messageGuid: string): Promise<void> {
    if (this.failAcks > 0) {
      this.failAcks -= 1;
      throw new ReceiptsApiError("Lakebed unavailable", 503, true);
    }
    this.acked.push(messageGuid);
    const entry = this.ledger.get(messageGuid);
    if (entry) entry.reply = null;
  }

  async fetchDue(): Promise<DueReminder[]> {
    return this.due.filter((reminder) => !this.reminded.includes(reminder.receiptId));
  }

  async markReminded(receiptId: string): Promise<void> {
    if (this.failReminded > 0) {
      this.failReminded -= 1;
      throw new ReceiptsApiError("Lakebed unavailable", 503, true);
    }
    if (!this.reminded.includes(receiptId)) this.reminded.push(receiptId);
  }

  async fetchAnnouncements(): Promise<DueAnnouncement[]> {
    return this.announcements.filter((announcement) => !this.announced.includes(announcement.announcementId));
  }

  async markAnnounced(announcementId: string): Promise<void> {
    if (this.failAnnounced > 0) {
      this.failAnnounced -= 1;
      throw new ReceiptsApiError("Lakebed unavailable", 503, true);
    }
    if (!this.announced.includes(announcementId)) this.announced.push(announcementId);
  }
}

export function silentLogger(): Logger & { entries: { level: string; message: string }[] } {
  const entries: { level: string; message: string }[] = [];
  return {
    entries,
    info: (message) => entries.push({ level: "info", message }),
    warn: (message) => entries.push({ level: "warn", message }),
    error: (message) => entries.push({ level: "error", message })
  };
}
