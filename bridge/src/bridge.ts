// The bridge loop: forward "@receipts" messages to Lakebed, send replies, reminders, and announcements
// back through BlueBubbles, and catch up on anything missed while the Mac was asleep.
// No product logic lives here.

import type { DueAnnouncement, DueReminder } from "../../app/shared/bot-api";
import type { BlueBubblesPort, BBMessage } from "./bluebubbles";
import { toIncomingMessage } from "./filter";
import { ReceiptsApiError, type ReceiptsPort } from "./receipts-api";
import { BlueBubblesReplyResolver, type ReplySourceResolver } from "./replies";
import { emptyState, MAX_RECENT_GUIDS, type BridgeState, type PendingAck, type StateStore } from "./state";

export type Logger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
};

export type BridgeOptions = {
  allowDirectChats: boolean;
  /** How far back the very first scan looks, before a ROWID cursor exists. */
  initialLookbackMs: number;
  /** Messages per BlueBubbles query page. */
  pageSize: number;
  /** Pages per scan; the next scan continues from the cursor. */
  maxPagesPerScan: number;
};

export type BridgeDeps = {
  bluebubbles: BlueBubblesPort;
  receipts: ReceiptsPort;
  /** Defaults to looking the replied-to message up through BlueBubbles. */
  replies?: ReplySourceResolver;
  store: StateStore;
  clock: () => number;
  utcOffsetMinutes: (at: number) => number;
  log: Logger;
  options: BridgeOptions;
};

export type CatchUpResult = { scanned: number; forwarded: number; stoppedEarly: boolean };
export type ReminderResult = { sent: number; failed: number };
export type AnnouncementResult = { sent: number; failed: number };

/** skipped: not for Lakebed. seen: already handled. forwarded: done. retry: transient failure, try again later. */
type Outcome = "skipped" | "seen" | "forwarded" | "retry";

export class Bridge {
  private readonly replies: ReplySourceResolver;
  private state: BridgeState = emptyState();
  private recent = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BridgeDeps) {
    this.replies = deps.replies ?? new BlueBubblesReplyResolver(deps.bluebubbles);
  }

  /** Loads local state. Call once before anything else. */
  async start(): Promise<void> {
    this.state = await this.deps.store.load();
    this.recent = new Set(this.state.recentGuids);
  }

  /**
   * Handles one BlueBubbles webhook body (`{ type, data }`). Never throws.
   * `new-message` is forwarded immediately; `hello-world` (BlueBubbles restarted) triggers a sync.
   */
  async handleWebhook(payload: unknown): Promise<void> {
    try {
      if (!isRecord(payload)) return;
      if (payload.type === "new-message" && isMessage(payload.data)) {
        await this.handleMessage(payload.data);
      } else if (payload.type === "hello-world") {
        await this.sync();
      }
    } catch (error) {
      this.deps.log.error("Webhook handling failed", { error: describe(error) });
    }
  }

  /** Forwards one message. Exposed for the webhook path and tests. */
  async handleMessage(message: BBMessage): Promise<void> {
    await this.serialize(() => this.forward(message));
  }

  /**
   * Scans BlueBubbles for messages after the cursor and forwards any not yet handled.
   * Stops at the first retryable failure so nothing is skipped.
   */
  catchUp(): Promise<CatchUpResult> {
    return this.serialize(() => this.scan());
  }

  /** Sends reminders Lakebed reports as due, then acknowledges each one. Never resends an unacknowledged send. */
  deliverReminders(): Promise<ReminderResult> {
    return this.serialize(async () => {
      await this.flushOwedAcks();
      return this.sendReminders();
    });
  }

  /** Sends group announcements Lakebed has ready, then acknowledges each one. Never resends an unacknowledged send. */
  deliverAnnouncements(): Promise<AnnouncementResult> {
    return this.serialize(async () => {
      await this.flushOwedAcks();
      return this.sendAnnouncements();
    });
  }

  /** Retries acknowledgements owed to Lakebed. */
  flushAcks(): Promise<void> {
    return this.serialize(() => this.flushOwedAcks());
  }

  /** Owed acks, then catch-up, then reminders and announcements. Used at startup and on wake. */
  sync(): Promise<void> {
    return this.serialize(async () => {
      await this.flushOwedAcks();
      await this.scan();
      await this.sendReminders();
      await this.sendAnnouncements();
    });
  }

  // --- Work (always run inside serialize) -----------------------------------

  /** One operation at a time: sends stay sequential and state writes never interleave. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async forward(message: BBMessage): Promise<Outcome> {
    const { bluebubbles, receipts, log, options, utcOffsetMinutes } = this.deps;
    const payload = toIncomingMessage(message, { allowDirectChats: options.allowDirectChats, utcOffsetMinutes });
    if (!payload) {
      return "skipped";
    }
    const guid = payload.messageGuid;
    if (this.recent.has(guid) || this.owesAck({ kind: "reply", messageGuid: guid })) {
      return "seen";
    }

    try {
      payload.replyTo = await this.replies.resolve(message);
    } catch (error) {
      log.warn("Could not look up the replied-to message; will retry", { guid, error: describe(error) });
      return "retry";
    }

    let result;
    try {
      result = await receipts.submitMessage(payload);
    } catch (error) {
      if (error instanceof ReceiptsApiError && !error.retryable) {
        log.error("Receipts rejected a message; skipping it", { guid, error: describe(error) });
        this.remember(guid);
        await this.persist();
        return "forwarded";
      }
      log.warn("Could not reach Receipts; will retry", { guid, error: describe(error) });
      return "retry";
    }

    if (result.reply) {
      try {
        await bluebubbles.sendText(payload.chatGuid, result.reply);
      } catch (error) {
        // Lakebed keeps the reply until it is acknowledged, so the next attempt resends it.
        log.error("Could not send a reply; will retry", { guid, error: describe(error) });
        return "retry";
      }
      const ack: PendingAck = { kind: "reply", messageGuid: guid };
      this.state.pendingAcks.push(ack);
      this.remember(guid);
      await this.persist();
      await this.acknowledge(ack);
      return "forwarded";
    }

    this.remember(guid);
    await this.persist();
    return "forwarded";
  }

  private async scan(): Promise<CatchUpResult> {
    const { bluebubbles, clock, log, options } = this.deps;
    const since = clock() - options.initialLookbackMs;
    const collected: BBMessage[] = [];
    try {
      for (let page = 0; page < options.maxPagesPerScan; page += 1) {
        const batch = await bluebubbles.queryMessages({
          afterRowId: this.state.cursorRowId,
          since,
          limit: options.pageSize,
          offset: page * options.pageSize
        });
        collected.push(...batch);
        if (batch.length < options.pageSize) break;
      }
    } catch (error) {
      log.warn("Catch-up scan could not query BlueBubbles", { error: describe(error) });
      return { scanned: 0, forwarded: 0, stoppedEarly: true };
    }

    collected.sort((a, b) => (a.originalROWID ?? 0) - (b.originalROWID ?? 0));
    let scanned = 0;
    let forwarded = 0;
    let stoppedEarly = false;
    for (const message of collected) {
      const outcome = await this.forward(message);
      if (outcome === "retry") {
        stoppedEarly = true;
        break;
      }
      scanned += 1;
      if (outcome === "forwarded") forwarded += 1;
      if (typeof message.originalROWID === "number") {
        this.state.cursorRowId = Math.max(this.state.cursorRowId ?? 0, message.originalROWID);
      }
    }
    await this.persist();
    if (forwarded > 0 || stoppedEarly) {
      log.info("Catch-up scan finished", { scanned, forwarded, stoppedEarly, cursorRowId: this.state.cursorRowId });
    }
    return { scanned, forwarded, stoppedEarly };
  }

  private async sendReminders(): Promise<ReminderResult> {
    const { bluebubbles, receipts, log } = this.deps;
    let reminders: DueReminder[];
    try {
      reminders = await receipts.fetchDue();
    } catch (error) {
      log.warn("Could not fetch due reminders", { error: describe(error) });
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    for (const reminder of reminders) {
      const ack: PendingAck = { kind: "reminder", receiptId: reminder.receiptId };
      if (this.owesAck(ack)) {
        continue;
      }
      try {
        await bluebubbles.sendText(reminder.chatGuid, reminder.message);
      } catch (error) {
        failed += 1;
        log.error("Could not send a reminder; will retry", { receiptId: reminder.receiptId, error: describe(error) });
        continue;
      }
      sent += 1;
      this.state.pendingAcks.push(ack);
      await this.persist();
      await this.acknowledge(ack);
    }
    if (sent > 0 || failed > 0) {
      log.info("Reminders delivered", { sent, failed });
    }
    return { sent, failed };
  }

  private async sendAnnouncements(): Promise<AnnouncementResult> {
    const { bluebubbles, receipts, log } = this.deps;
    let announcements: DueAnnouncement[];
    try {
      announcements = await receipts.fetchAnnouncements();
    } catch (error) {
      log.warn("Could not fetch announcements", { error: describe(error) });
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    for (const announcement of announcements) {
      const ack: PendingAck = { kind: "announcement", announcementId: announcement.announcementId };
      if (this.owesAck(ack)) {
        continue;
      }
      try {
        await bluebubbles.sendText(announcement.chatGuid, announcement.message);
      } catch (error) {
        failed += 1;
        log.error("Could not send an announcement; will retry", { announcementId: announcement.announcementId, error: describe(error) });
        continue;
      }
      sent += 1;
      this.state.pendingAcks.push(ack);
      await this.persist();
      await this.acknowledge(ack);
    }
    if (sent > 0 || failed > 0) {
      log.info("Announcements delivered", { sent, failed });
    }
    return { sent, failed };
  }

  private async flushOwedAcks(): Promise<void> {
    for (const ack of [...this.state.pendingAcks]) {
      await this.acknowledge(ack);
    }
  }

  /** Tells Lakebed a send happened. Keeps the ack owed on transient failure; drops it if Lakebed can never accept it. */
  private async acknowledge(ack: PendingAck): Promise<void> {
    const { receipts, log } = this.deps;
    try {
      if (ack.kind === "reply") {
        await receipts.ackReply(ack.messageGuid);
      } else if (ack.kind === "reminder") {
        await receipts.markReminded(ack.receiptId);
      } else {
        await receipts.markAnnounced(ack.announcementId);
      }
    } catch (error) {
      if (!(error instanceof ReceiptsApiError) || error.retryable) {
        log.warn("Acknowledgement failed; will retry", { ack, error: describe(error) });
        return;
      }
      log.warn("Acknowledgement rejected; dropping it", { ack, error: describe(error) });
    }
    this.state.pendingAcks = this.state.pendingAcks.filter((owed) => !sameAck(owed, ack));
    await this.persist();
  }

  private owesAck(ack: PendingAck): boolean {
    return this.state.pendingAcks.some((owed) => sameAck(owed, ack));
  }

  private remember(guid: string): void {
    if (this.recent.has(guid)) return;
    this.recent.add(guid);
    this.state.recentGuids.push(guid);
    while (this.state.recentGuids.length > MAX_RECENT_GUIDS) {
      const dropped = this.state.recentGuids.shift();
      if (dropped !== undefined) this.recent.delete(dropped);
    }
  }

  private persist(): Promise<void> {
    return this.deps.store.save(this.state);
  }
}

function sameAck(a: PendingAck, b: PendingAck): boolean {
  switch (a.kind) {
    case "reply":
      return b.kind === "reply" && a.messageGuid === b.messageGuid;
    case "reminder":
      return b.kind === "reminder" && a.receiptId === b.receiptId;
    case "announcement":
      return b.kind === "announcement" && a.announcementId === b.announcementId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is BBMessage {
  return isRecord(value) && typeof value.guid === "string" && typeof value.dateCreated === "number";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
