import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError, loadConfig, parseEnvFile } from "../src/config";
import { emptyState, FileStateStore, type BridgeState } from "../src/state";
import { createWebhookServer, MAX_WEBHOOK_BYTES } from "../src/webhook-server";

describe("FileStateStore", () => {
  it("loads empty state when the file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "receipts-bridge-"));
    assert.deepEqual(await new FileStateStore(join(dir, "nested", "state.json")).load(), emptyState());
    assert.deepEqual(emptyState(), { version: 1, cursorRowId: null, recentGuids: [], pendingAcks: [] });
  });

  it("round-trips state through a private file without leaving temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "receipts-bridge-"));
    const path = join(dir, "nested", "state.json");
    const store = new FileStateStore(path);
    const state: BridgeState = {
      version: 1,
      cursorRowId: 42,
      recentGuids: ["a", "b"],
      pendingAcks: [{ kind: "reply", messageGuid: "a" }, { kind: "reminder", receiptId: "r" }]
    };
    await store.save(state);
    assert.deepEqual(await new FileStateStore(path).load(), state);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "nested")), ["state.json"]);
  });

  it("keeps owed announcement acknowledgements", async () => {
    const dir = await mkdtemp(join(tmpdir(), "receipts-bridge-"));
    const path = join(dir, "state.json");
    const state: BridgeState = {
      version: 1,
      cursorRowId: null,
      recentGuids: [],
      pendingAcks: [{ kind: "announcement", announcementId: "a" }]
    };
    await new FileStateStore(path).save(state);
    assert.deepEqual(await new FileStateStore(path).load(), state);
    await writeFile(path, JSON.stringify({ ...state, pendingAcks: [{ kind: "announcement" }, { kind: "other", id: "x" }] }));
    assert.deepEqual((await new FileStateStore(path).load()).pendingAcks, []);
  });

  it("sets a corrupt file aside and starts fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "receipts-bridge-"));
    const path = join(dir, "state.json");
    await writeFile(path, "{not json");
    assert.deepEqual(await new FileStateStore(path).load(), emptyState());
    const files = await readdir(dir);
    assert.equal(files.some((file) => file.startsWith("state.json.corrupt-")), true);
  });

  it("fills in missing fields from older files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "receipts-bridge-"));
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ version: 1, cursorRowId: 7 }));
    assert.deepEqual(await new FileStateStore(path).load(), { version: 1, cursorRowId: 7, recentGuids: [], pendingAcks: [] });
  });
});

describe("config", () => {
  const required = {
    RECEIPTS_URL: "https://receipts.lakebed.app/",
    RECEIPTS_BOT_SECRET: "bot-secret",
    BLUEBUBBLES_PASSWORD: "bb-password",
    BRIDGE_WEBHOOK_SECRET: "hook-secret"
  };

  it("applies defaults", () => {
    assert.deepEqual(loadConfig(required, "/Users/receiptsbot"), {
      receiptsUrl: "https://receipts.lakebed.app",
      botSecret: "bot-secret",
      bluebubblesUrl: "http://127.0.0.1:1234",
      bluebubblesPassword: "bb-password",
      listenHost: "127.0.0.1",
      listenPort: 8787,
      webhookSecret: "hook-secret",
      stateFile: "/Users/receiptsbot/Library/Application Support/ReceiptsBridge/state.json",
      allowDirectChats: false,
      catchUpIntervalMs: 5 * 60 * 1000,
      reminderIntervalMs: 60 * 60 * 1000,
      initialLookbackMs: 24 * 60 * 60 * 1000
    });
  });

  it("reads overrides", () => {
    const config = loadConfig(
      {
        ...required,
        BLUEBUBBLES_URL: "http://localhost:4321",
        BRIDGE_PORT: "9000",
        BRIDGE_ALLOW_DIRECT_CHATS: "true",
        BRIDGE_CATCH_UP_MINUTES: "2",
        BRIDGE_REMINDER_MINUTES: "30",
        BRIDGE_LOOKBACK_HOURS: "48",
        BRIDGE_STATE_FILE: "/tmp/state.json"
      },
      "/home"
    );
    assert.equal(config.bluebubblesUrl, "http://localhost:4321");
    assert.equal(config.listenPort, 9000);
    assert.equal(config.allowDirectChats, true);
    assert.equal(config.catchUpIntervalMs, 2 * 60 * 1000);
    assert.equal(config.reminderIntervalMs, 30 * 60 * 1000);
    assert.equal(config.initialLookbackMs, 48 * 60 * 60 * 1000);
    assert.equal(config.stateFile, "/tmp/state.json");
  });

  it("names every missing or invalid setting", () => {
    assert.throws(() => loadConfig({}, "/home"), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      for (const name of Object.keys(required)) assert.match(error.message, new RegExp(name));
      return true;
    });
    assert.throws(() => loadConfig({ ...required, BRIDGE_PORT: "eighty" }, "/home"), /BRIDGE_PORT/);
    assert.throws(() => loadConfig({ ...required, RECEIPTS_URL: "receipts.lakebed.app" }, "/home"), /RECEIPTS_URL/);
    assert.throws(() => loadConfig({ ...required, RECEIPTS_URL: "http://receipts.lakebed.app" }, "/home"), /https/);
  });

  it("parses env files", () => {
    assert.deepEqual(
      parseEnvFile(["# comment", "", "A=1", "export B = two ", 'C="quoted # value"', "D='single'", "E=x=y", "bad line"].join("\n")),
      { A: "1", B: "two", C: "quoted # value", D: "single", E: "x=y" }
    );
  });
});

describe("webhook server", () => {
  const events: unknown[] = [];
  const server = createWebhookServer({ secret: "hook-secret", onEvent: (payload) => events.push(payload) });
  let base = "";

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  it("accepts authenticated JSON events", async () => {
    const payload = { type: "new-message", data: { guid: "g" } };
    const response = await fetch(`${base}/bluebubbles?secret=hook-secret`, { method: "POST", body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.at(-1), payload);
  });

  it("rejects bad secrets, bad JSON, oversized bodies, and unknown routes", async () => {
    const before = events.length;
    assert.equal((await fetch(`${base}/bluebubbles?secret=nope`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/bluebubbles`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/bluebubbles?secret=hook-secret`, { method: "POST", body: "{nope" })).status, 400);
    const huge = await fetch(`${base}/bluebubbles?secret=hook-secret`, { method: "POST", body: "x".repeat(MAX_WEBHOOK_BYTES + 1) }).catch(
      () => null
    );
    assert.ok(huge === null || huge.status === 413);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
    assert.equal(events.length, before);
  });

  it("reports health", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });

  it("does not echo secrets", async () => {
    const response = await fetch(`${base}/bluebubbles?secret=nope`, { method: "POST", body: "{}" });
    assert.equal((await response.text()).includes("hook-secret"), false);
  });
});
