// Minimal BlueBubbles Server REST client (no Private API).
// Auth is the server password as a `password` query parameter.

import { randomUUID } from "node:crypto";

export type BBHandle = { address: string };

export type BBChat = {
  guid: string;
  displayName?: string | null;
  /** 43 = group, 45 = one-to-one. */
  style?: number;
};

/** The subset of BlueBubbles' serialized Message the bridge reads. */
export type BBMessage = {
  guid: string;
  /** chat.db ROWID; the catch-up cursor. */
  originalROWID?: number;
  text: string | null;
  isFromMe: boolean;
  /** Epoch ms. */
  dateCreated: number;
  handle?: BBHandle | null;
  chats?: BBChat[];
  associatedMessageGuid?: string | null;
  associatedMessageType?: string | null;
  itemType?: number;
  /** Set on native iMessage replies: the GUID of the thread's first message. */
  threadOriginatorGuid?: string | null;
};

export type MessageQuery = {
  /** Only messages with a larger ROWID. Null on first run. */
  afterRowId: number | null;
  /** Epoch ms lower bound used when there is no ROWID cursor yet. */
  since: number;
  limit: number;
  offset: number;
};

export interface BlueBubblesPort {
  ping(): Promise<void>;
  /** Messages matching the query, in ascending ROWID order, with their chats attached. */
  queryMessages(query: MessageQuery): Promise<BBMessage[]>;
  /** One message by GUID with its chats, or null when it does not exist. */
  getMessage(guid: string): Promise<BBMessage | null>;
  /** Replies in `chatGuid` whose thread starts at `originatorGuid`, sent at or before `before` (epoch ms), oldest first. */
  threadReplies(chatGuid: string, originatorGuid: string, before: number, limit: number): Promise<BBMessage[]>;
  /** Sends plain text into an existing chat. Resolves once Messages.app recorded the send. */
  sendText(chatGuid: string, text: string): Promise<void>;
}

export class BlueBubblesError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

export type BlueBubblesClientOptions = {
  /** e.g. "http://127.0.0.1:1234" */
  baseUrl: string;
  password: string;
  fetch?: typeof fetch;
  /** BlueBubbles holds send requests open until chat.db shows the message (up to ~2 minutes). */
  sendTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type Envelope = { status?: number; message?: string; data?: unknown; error?: { message?: string } };

export class BlueBubblesClient implements BlueBubblesPort {
  private readonly baseUrl: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sendTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: BlueBubblesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.password = options.password;
    this.fetchImpl = options.fetch ?? fetch;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 150_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async ping(): Promise<void> {
    await this.request("GET", "/api/v1/ping");
  }

  async queryMessages(query: MessageQuery): Promise<BBMessage[]> {
    // BlueBubbles sorts by message date, not ROWID. Choose the page by ROWID inside
    // the supported WHERE clause so delayed messages cannot skip unscanned rows.
    // Include only messages with a chat, matching BlueBubbles' outer inner join.
    const firstScan = query.afterRowId === null;
    const body = {
      limit: query.limit,
      offset: 0,
      sort: "ASC",
      with: ["chat"],
      where: [{
        statement: "message.ROWID IN (SELECT m.ROWID FROM message AS m " +
          "INNER JOIN chat_message_join AS cm ON cm.message_id = m.ROWID " +
          "INNER JOIN chat AS c ON c.ROWID = cm.chat_id " +
          `WHERE ${firstScan ? "m.date >= :since" : "m.ROWID > :rowId"} ` +
          "GROUP BY m.ROWID ORDER BY m.ROWID ASC LIMIT :pageLimit OFFSET :pageOffset)",
        args: {
          // chat.db stores nanoseconds since 2001 on macOS versions supported by Node 20+.
          ...(firstScan ? { since: (query.since - Date.UTC(2001, 0, 1)) * 1_000_000 } : { rowId: query.afterRowId }),
          pageLimit: query.limit,
          pageOffset: query.offset
        }
      }]
    };
    const data = await this.request("POST", "/api/v1/message/query", body);
    if (!Array.isArray(data)) {
      throw new BlueBubblesError("BlueBubbles returned an unexpected message list.", 200);
    }
    return (data as BBMessage[]).sort((a, b) => (a.originalROWID ?? 0) - (b.originalROWID ?? 0));
  }

  async getMessage(guid: string): Promise<BBMessage | null> {
    try {
      const data = await this.request("GET", `/api/v1/message/${encodeURIComponent(guid)}`, undefined, this.requestTimeoutMs, { with: "chat" });
      return (data as BBMessage | null) ?? null;
    } catch (error) {
      if (error instanceof BlueBubblesError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async threadReplies(chatGuid: string, originatorGuid: string, before: number, limit: number): Promise<BBMessage[]> {
    // Raw column name: TypeORM leaves it untouched, so this works whether or not it maps property names.
    const data = await this.request("POST", "/api/v1/message/query", {
      chatGuid,
      limit,
      offset: 0,
      sort: "ASC",
      before,
      where: [{ statement: "message.thread_originator_guid = :originator", args: { originator: originatorGuid } }]
    });
    if (!Array.isArray(data)) {
      throw new BlueBubblesError("BlueBubbles returned an unexpected message list.", 200);
    }
    return data as BBMessage[];
  }

  async sendText(chatGuid: string, text: string): Promise<void> {
    // Only these four fields: any Private API field would switch BlueBubbles to the Private API.
    await this.request(
      "POST",
      "/api/v1/message/text",
      { chatGuid, tempGuid: `receipts-${randomUUID()}`, message: text, method: "apple-script" },
      this.sendTimeoutMs
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = this.requestTimeoutMs,
    query: Record<string, string> = {}
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams({ password: this.password, ...query })}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new BlueBubblesError(`BlueBubbles unreachable: ${describe(error)}`, null);
    }
    let envelope: Envelope | null = null;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      envelope = null;
    }
    if (!response.ok || !envelope || (typeof envelope.status === "number" && envelope.status >= 400)) {
      const detail = envelope?.error?.message ?? envelope?.message ?? response.statusText;
      throw new BlueBubblesError(`BlueBubbles ${method} ${path} failed (${response.status}): ${detail}`, response.status);
    }
    return envelope.data;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
