// Client for the Lakebed app's /api/bot/* endpoints.

import {
  BOT_ROUTES,
  type DueAnnouncement,
  type DueReminder,
  type IncomingMessage,
  type IncomingMessageResult,
  type PingResponse
} from "../../app/shared/bot-api";

export interface ReceiptsPort {
  ping(): Promise<PingResponse>;
  submitMessage(message: IncomingMessage): Promise<IncomingMessageResult>;
  ackReply(messageGuid: string): Promise<void>;
  fetchDue(): Promise<DueReminder[]>;
  markReminded(receiptId: string): Promise<void>;
  fetchAnnouncements(): Promise<DueAnnouncement[]>;
  markAnnounced(announcementId: string): Promise<void>;
}

export class ReceiptsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** False for message-specific failures such as a bad payload or unknown id. */
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export type ReceiptsApiClientOptions = {
  /** Lakebed app origin, e.g. "https://receipts.lakebed.app". */
  baseUrl: string;
  /** RECEIPTS_BOT_SECRET. */
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class ReceiptsApiClient implements ReceiptsPort {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ReceiptsApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secret = options.secret;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async ping(): Promise<PingResponse> {
    const body = await this.request("GET", BOT_ROUTES.ping);
    if (!isRecord(body) || body.ok !== true || typeof body.now !== "number") {
      throw unexpected(BOT_ROUTES.ping);
    }
    return { ok: true, now: body.now };
  }

  async submitMessage(message: IncomingMessage): Promise<IncomingMessageResult> {
    const body = await this.request("POST", BOT_ROUTES.message, message);
    if (
      !isRecord(body) ||
      (body.status !== "processed" && body.status !== "duplicate" && body.status !== "ignored") ||
      (body.reply !== null && typeof body.reply !== "string")
    ) {
      throw unexpected(BOT_ROUTES.message);
    }
    return { status: body.status, reply: body.reply };
  }

  async ackReply(messageGuid: string): Promise<void> {
    await this.request("POST", BOT_ROUTES.messageAck, { messageGuid });
  }

  async fetchDue(): Promise<DueReminder[]> {
    const body = await this.request("GET", BOT_ROUTES.due);
    if (!isRecord(body) || !Array.isArray(body.reminders)) {
      throw unexpected(BOT_ROUTES.due);
    }
    return body.reminders.filter(
      (reminder): reminder is DueReminder =>
        isRecord(reminder) &&
        typeof reminder.receiptId === "string" &&
        typeof reminder.chatGuid === "string" &&
        typeof reminder.message === "string"
    );
  }

  async markReminded(receiptId: string): Promise<void> {
    await this.request("POST", BOT_ROUTES.reminded, { receiptId });
  }

  async fetchAnnouncements(): Promise<DueAnnouncement[]> {
    const body = await this.request("GET", BOT_ROUTES.announcements);
    if (!isRecord(body) || !Array.isArray(body.announcements)) {
      throw unexpected(BOT_ROUTES.announcements);
    }
    return body.announcements.filter(
      (announcement): announcement is DueAnnouncement =>
        isRecord(announcement) &&
        typeof announcement.announcementId === "string" &&
        typeof announcement.chatGuid === "string" &&
        typeof announcement.message === "string"
    );
  }

  async markAnnounced(announcementId: string): Promise<void> {
    await this.request("POST", BOT_ROUTES.announced, { announcementId });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new ReceiptsApiError(`Receipts unreachable: ${error instanceof Error ? error.message : String(error)}`, null, true);
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : response.statusText;
      // An expired/mismatched secret can be corrected. Keep messages and owed acknowledgements
      // pending in the meantime instead of permanently skipping commands or allowing duplicate sends.
      const retryable = [401, 403, 408, 429].includes(response.status) || response.status >= 500;
      throw new ReceiptsApiError(`Receipts ${method} ${path} failed (${response.status}): ${detail}`, response.status, retryable);
    }
    return parsed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpected(path: string): ReceiptsApiError {
  return new ReceiptsApiError(`Receipts ${path} returned an unexpected body.`, 200, true);
}
