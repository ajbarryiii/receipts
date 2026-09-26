// Runs the real capsule definition against Lakebed's in-memory StateCell,
// the same way `lakebed dev` does, without a server or browser.

import { LogBuffer, StateCell } from "lakebed/runtime";
import type {
  EndpointDefinition,
  EndpointRequest,
  EndpointResponse,
  MutationArgs,
  MutationName,
  MutationResult,
  QueryArgs,
  QueryName,
  QueryResult
} from "lakebed/server";
import { createAuthContext } from "lakebed/server";
import app from "../../app/server/index";
import type { IncomingMessage, IncomingMessageResult, ReplySource } from "../../app/shared/bot-api";

type App = typeof app;
type AnyHandler = (ctx: unknown, ...args: unknown[]) => unknown;
type AuthInput = Record<string, unknown>;

export const BOT_SECRET = "test-bot-secret-0123456789abcdef";
export const APP_URL = "https://receipts.test";
export const CHAT = "iMessage;+;chat-boys";
export const OTHER_CHAT = "iMessage;+;chat-work";
export const JR_HANDLE = "+15555550123";
export const CONNOR_HANDLE = "+15555550999";

export const signedOut: AuthInput = {};

export function account(userId: string, displayName = userId): AuthInput {
  return { userId, subject: userId, provider: "google", isAuthenticated: true, isGuest: false, isSignedIn: true, displayName };
}

export function guest(userId: string): AuthInput {
  return { userId, provider: "guest", isAuthenticated: false, isGuest: true, isSignedIn: false, displayName: "Guest" };
}

export type HttpResult = { status: number; body: unknown };

/** Mimics the JSON wire format between server and client. */
function roundTrip<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class TestApp {
  readonly cell = new StateCell(app.schema);
  readonly logs = new LogBuffer();
  private messageCounter = 0;
  private sourceCounter = 0;

  constructor(readonly env: Record<string, string | undefined> = { RECEIPTS_BOT_SECRET: BOT_SECRET, APP_URL }) {}

  private context(db: unknown, auth: AuthInput) {
    return { auth: createAuthContext(auth), db, env: this.env, log: this.logs.createLogger() };
  }

  async query<N extends QueryName<App>>(name: N, auth: AuthInput, ...args: QueryArgs<App, N>): Promise<QueryResult<App, N>> {
    const handler = (app.queries as Record<string, AnyHandler>)[name];
    const result = await this.cell.read((db) => handler(this.context(db, auth), ...args), name);
    return roundTrip(result as QueryResult<App, N>);
  }

  async mutation<N extends MutationName<App>>(
    name: N,
    auth: AuthInput,
    ...args: MutationArgs<App, N>
  ): Promise<MutationResult<App, N>> {
    const handler = (app.mutations as Record<string, AnyHandler>)[name];
    const { result } = await this.cell.transaction(async (db) => handler(this.context(db, auth), ...args));
    return roundTrip(result as MutationResult<App, N>);
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; rawBody?: string; headers?: Record<string, string>; auth?: AuthInput } = {}
  ): Promise<HttpResult> {
    const endpoint = Object.values(app.endpoints as Record<string, EndpointDefinition<unknown, boolean>>).find(
      (candidate) => candidate.method === method && candidate.path === path
    );
    if (!endpoint) {
      return { status: 404, body: null };
    }
    const bodyText = options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body));
    const headers = new Map(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const url = `${APP_URL}${path}`;
    const request: EndpointRequest = {
      method,
      path,
      url,
      headers: {
        get: (name) => headers.get(name.toLowerCase()) ?? null,
        has: (name) => headers.has(name.toLowerCase()),
        entries: () => headers.entries()
      },
      query: new URL(url).searchParams,
      text: async () => bodyText,
      json: async <T>() => JSON.parse(bodyText) as T,
      bytes: async () => new TextEncoder().encode(bodyText)
    };
    const run = async (db: unknown) =>
      (await endpoint.handler(this.context(db, options.auth ?? signedOut) as never, request)) as EndpointResponse;
    const response = endpoint.readOnly ? await this.cell.read(run, path) : (await this.cell.transaction(run)).result;
    return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
  }

  /** Authenticated bot call. */
  bot(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResult> {
    return this.request(method, path, { body, headers: { Authorization: `Bearer ${BOT_SECRET}` } });
  }

  /** Sends a chat message through the bot endpoint and returns the parsed result. */
  async chat(text: string, overrides: Partial<IncomingMessage> = {}): Promise<IncomingMessageResult & { messageGuid: string }> {
    this.messageCounter += 1;
    const message: IncomingMessage = {
      messageGuid: `msg-${this.messageCounter}`,
      chatGuid: CHAT,
      chatName: "The Boys",
      senderHandle: JR_HANDLE,
      text,
      sentAt: Date.now() - 1000,
      utcOffsetMinutes: -420,
      replyTo: null,
      ...overrides
    };
    const response = await this.bot("POST", "/api/bot/message", message);
    if (response.status !== 200) {
      throw new Error(`bot message failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return { ...(response.body as IncomingMessageResult), messageGuid: message.messageGuid };
  }

  /** Sends an "@receipts" command as a native iMessage reply to `source`. */
  reply(
    text: string,
    source: Partial<ReplySource> & Pick<ReplySource, "text" | "authorHandle">,
    overrides: Partial<IncomingMessage> = {}
  ): Promise<IncomingMessageResult & { messageGuid: string }> {
    this.sourceCounter += 1;
    const replyTo: ReplySource = {
      messageGuid: `source-${this.sourceCounter}`,
      sentAt: Date.now() - 60_000,
      ambiguous: false,
      ...source
    };
    return this.chat(text, { replyTo, ...overrides });
  }

  async rows(table: string): Promise<Record<string, unknown>[]> {
    const dump = await this.cell.dump();
    return (dump.tables[table] ?? []) as Record<string, unknown>[];
  }
}

/** Pulls the /join/<token> token out of a bot reply. */
export function tokenFrom(reply: string | null): string {
  const match = /\/join\/([A-Za-z0-9]+)/.exec(reply ?? "");
  if (!match) {
    throw new Error(`no join link in: ${reply}`);
  }
  return match[1];
}
