import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage } from "../../app/shared/bot-api";
import { BlueBubblesClient, BlueBubblesError } from "../src/bluebubbles";
import { ReceiptsApiClient, ReceiptsApiError } from "../src/receipts-api";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(respond: (call: Call) => { status: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("BlueBubblesClient", () => {
  const ok = (data: unknown) => ({ status: 200, body: { status: 200, message: "Success", data } });

  it("authenticates with the password query parameter", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok("pong"));
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234/", password: "p&ss word", fetch: fetchImpl });
    await client.ping();
    assert.equal(calls[0].url, "http://127.0.0.1:1234/api/v1/ping?password=p%26ss+word");
    assert.equal(calls[0].method, "GET");
  });

  it("queries by ROWID once a cursor exists", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok([{ guid: "a" }]));
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
    const messages = await client.queryMessages({ afterRowId: 41, since: 1000, limit: 100, offset: 200 });
    assert.deepEqual(messages, [{ guid: "a" }]);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "http://127.0.0.1:1234/api/v1/message/query?password=pw");
    const body = calls[0].body as { limit: number; offset: number; with: string[]; where: { statement: string; args: unknown }[] };
    assert.equal(body.limit, 100);
    assert.equal(body.offset, 0);
    assert.deepEqual(body.with, ["chat"]);
    assert.match(body.where[0].statement, /WHERE m\.ROWID > :rowId GROUP BY m\.ROWID ORDER BY m\.ROWID ASC LIMIT :pageLimit OFFSET :pageOffset/);
    assert.deepEqual(body.where[0].args, { rowId: 41, pageLimit: 100, pageOffset: 200 });
  });

  it("queries by time before a cursor exists", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok([]));
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
    await client.queryMessages({ afterRowId: null, since: 1_790_000_000_000, limit: 50, offset: 0 });
    const body = calls[0].body as { where: { statement: string; args: unknown }[] };
    assert.match(body.where[0].statement, /WHERE m\.date >= :since GROUP BY m\.ROWID ORDER BY m\.ROWID ASC/);
    assert.deepEqual(body.where[0].args, { since: 811_692_800_000_000_000, pageLimit: 50, pageOffset: 0 });
  });

  it("returns the selected page in cursor order even when BlueBubbles sorts it by date", async () => {
    const { fetchImpl } = fakeFetch(() => ok([{ originalROWID: 8 }, { originalROWID: 6 }, { originalROWID: 7 }]));
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
    const messages = await client.queryMessages({ afterRowId: 5, since: 1000, limit: 3, offset: 0 });
    assert.deepEqual(messages.map((message) => message.originalROWID), [6, 7, 8]);
  });

  it("looks up one message by GUID", async () => {
    const { calls, fetchImpl } = fakeFetch((call) =>
      call.url.includes("missing")
        ? { status: 404, body: { status: 404, message: "Message does not exist!" } }
        : ok({ guid: "iMessage;+;abc/123", text: "hi" })
    );
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
    assert.deepEqual(await client.getMessage("p:0/ABC-123"), { guid: "iMessage;+;abc/123", text: "hi" });
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url, "http://127.0.0.1:1234/api/v1/message/p%3A0%2FABC-123?password=pw&with=chat");
    assert.equal(await client.getMessage("missing"), null);
  });

  it("queries one reply thread in one chat", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok([{ guid: "r1" }]));
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
    assert.deepEqual(await client.threadReplies("iMessage;+;chat1", "root-guid", 1_790_000_000_000, 25), [{ guid: "r1" }]);
    assert.equal(calls[0].url, "http://127.0.0.1:1234/api/v1/message/query?password=pw");
    assert.deepEqual(calls[0].body, {
      chatGuid: "iMessage;+;chat1",
      limit: 25,
      offset: 0,
      sort: "ASC",
      before: 1_790_000_000_000,
      where: [{ statement: "message.thread_originator_guid = :originator", args: { originator: "root-guid" } }]
    });
  });

  it("sends text with AppleScript and a fresh temp GUID", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok({ guid: "sent" }));
    const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
    await client.sendText("iMessage;+;chat1", "🧾 hi");
    await client.sendText("iMessage;+;chat1", "🧾 hi");
    assert.equal(calls[0].url, "http://127.0.0.1:1234/api/v1/message/text?password=pw");
    const [first, second] = calls.map((call) => call.body as Record<string, string>);
    assert.equal(first.chatGuid, "iMessage;+;chat1");
    assert.equal(first.message, "🧾 hi");
    assert.equal(first.method, "apple-script");
    assert.match(first.tempGuid, /^receipts-/);
    assert.notEqual(first.tempGuid, second.tempGuid);
    assert.deepEqual(Object.keys(first).sort(), ["chatGuid", "message", "method", "tempGuid"]);
  });

  it("raises BlueBubblesError on failures", async () => {
    const failing = [
      { status: 500, body: { status: 500, message: "Failed to send message!", error: { type: "iMessage Error", message: "timeout" } } },
      { status: 401, body: { status: 401, message: "Unauthorized" } },
      new TypeError("fetch failed")
    ];
    for (const response of failing) {
      const { fetchImpl } = fakeFetch(() => response);
      const client = new BlueBubblesClient({ baseUrl: "http://127.0.0.1:1234", password: "pw", fetch: fetchImpl });
      await assert.rejects(client.sendText("c", "t"), (error: unknown) => {
        assert.ok(error instanceof BlueBubblesError);
        assert.equal(error.status, response instanceof Error ? null : response.status);
        return true;
      });
    }
  });
});

describe("ReceiptsApiClient", () => {
  const message: IncomingMessage = {
    messageGuid: "m1",
    chatGuid: "iMessage;+;chat1",
    chatName: "The Boys",
    senderHandle: "+15555550123",
    text: "@receipts list",
    sentAt: 1,
    utcOffsetMinutes: -420,
    replyTo: { messageGuid: "src", text: "No chance.", authorHandle: "+15555550999", sentAt: 1, ambiguous: false }
  };

  function client(respond: Parameters<typeof fakeFetch>[0]) {
    const fake = fakeFetch(respond);
    return { ...fake, api: new ReceiptsApiClient({ baseUrl: "https://receipts.test/", secret: "s3cret", fetch: fake.fetchImpl }) };
  }

  it("calls each bot route with the bearer secret", async () => {
    const { calls, api } = client((call) => {
      if (call.url.endsWith("/api/bot/message")) return { status: 200, body: { status: "processed", reply: "🧾 ok" } };
      if (call.url.endsWith("/api/bot/due")) return { status: 200, body: { reminders: [{ receiptId: "r", chatGuid: "c", message: "m" }] } };
      if (call.url.endsWith("/api/bot/ping")) return { status: 200, body: { ok: true, now: 5 } };
      return { status: 200, body: { ok: true } };
    });

    assert.deepEqual(await api.submitMessage(message), { status: "processed", reply: "🧾 ok" });
    await api.ackReply("m1");
    assert.deepEqual(await api.fetchDue(), [{ receiptId: "r", chatGuid: "c", message: "m" }]);
    await api.markReminded("r");
    assert.deepEqual(await api.ping(), { ok: true, now: 5 });

    assert.deepEqual(
      calls.map((call) => [call.method, call.url, call.body]),
      [
        ["POST", "https://receipts.test/api/bot/message", message],
        ["POST", "https://receipts.test/api/bot/message/ack", { messageGuid: "m1" }],
        ["GET", "https://receipts.test/api/bot/due", undefined],
        ["POST", "https://receipts.test/api/bot/reminded", { receiptId: "r" }],
        ["GET", "https://receipts.test/api/bot/ping", undefined]
      ]
    );
    for (const call of calls) {
      assert.equal(call.headers.authorization, "Bearer s3cret");
    }
    assert.equal(calls[0].headers["content-type"], "application/json");
  });

  it("fetches and acknowledges announcements", async () => {
    const { calls, api } = client((call) =>
      call.url.endsWith("/api/bot/announcements")
        ? { status: 200, body: { announcements: [{ announcementId: "a", chatGuid: "c", message: "👑" }, { announcementId: 5 }] } }
        : { status: 200, body: { ok: true } }
    );
    assert.deepEqual(await api.fetchAnnouncements(), [{ announcementId: "a", chatGuid: "c", message: "👑" }]);
    await api.markAnnounced("a");
    assert.deepEqual(
      calls.map((call) => [call.method, call.url, call.body]),
      [
        ["GET", "https://receipts.test/api/bot/announcements", undefined],
        ["POST", "https://receipts.test/api/bot/announced", { announcementId: "a" }]
      ]
    );
    const malformed = client(() => ({ status: 200, body: { announcements: "nope" } }));
    await assert.rejects(malformed.api.fetchAnnouncements(), ReceiptsApiError);
  });

  it("classifies failures as retryable or permanent", async () => {
    const cases: [number | Error, boolean][] = [
      [400, false],
      [401, true],
      [403, true],
      [404, false],
      [429, true],
      [500, true],
      [503, true],
      [new TypeError("fetch failed"), true]
    ];
    for (const [response, retryable] of cases) {
      const { api } = client(() => (response instanceof Error ? response : { status: response, body: { error: "nope" } }));
      await assert.rejects(api.submitMessage(message), (error: unknown) => {
        assert.ok(error instanceof ReceiptsApiError);
        assert.equal(error.retryable, retryable, String(response));
        assert.equal(error.status, response instanceof Error ? null : response);
        return true;
      });
    }
  });

  it("rejects malformed success bodies", async () => {
    const { api } = client(() => ({ status: 200, body: { status: "processed" } }));
    await assert.rejects(api.submitMessage(message), ReceiptsApiError);
    const due = client(() => ({ status: 200, body: { reminders: "nope" } }));
    await assert.rejects(due.api.fetchDue(), ReceiptsApiError);
  });
});
