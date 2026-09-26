// Receipts bridge entry point. Runs as a LaunchAgent in the "Receipts Bot" macOS user.
//
//   node receipts-bridge.mjs          run the bridge
//   node receipts-bridge.mjs check    verify BlueBubbles and Receipts are reachable, then exit
//
// Configuration comes from the environment, optionally loaded from an env file
// (RECEIPTS_BRIDGE_ENV_FILE, default ~/.receipts-bridge.env). See bridge/README.md.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlueBubblesClient } from "./bluebubbles";
import { Bridge, type Logger } from "./bridge";
import { ConfigError, loadConfig, parseEnvFile, type BridgeConfig } from "./config";
import { ReceiptsApiClient } from "./receipts-api";
import { FileStateStore } from "./state";
import { createWebhookServer } from "./webhook-server";

const TICK_MS = 30_000;
/** A tick this late means the Mac slept. */
const WAKE_GAP_MS = 3 * 60_000;

function createLogger(): Logger {
  const write = (level: string, message: string, data?: Record<string, unknown>) => {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${new Date().toISOString()} ${level} ${message}${suffix}`;
    if (level === "ERROR") console.error(line);
    else console.log(line);
  };
  return {
    info: (message, data) => write("INFO", message, data),
    warn: (message, data) => write("WARN", message, data),
    error: (message, data) => write("ERROR", message, data)
  };
}

function readConfig(): BridgeConfig {
  const envFile = process.env.RECEIPTS_BRIDGE_ENV_FILE ?? join(homedir(), ".receipts-bridge.env");
  const fromFile = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  return loadConfig({ ...fromFile, ...process.env }, homedir());
}

async function check(config: BridgeConfig, log: Logger): Promise<boolean> {
  const bluebubbles = new BlueBubblesClient({ baseUrl: config.bluebubblesUrl, password: config.bluebubblesPassword });
  const receipts = new ReceiptsApiClient({ baseUrl: config.receiptsUrl, secret: config.botSecret });
  const results = await Promise.allSettled([bluebubbles.ping(), receipts.ping()]);
  const [bb, rc] = results;
  if (bb.status === "fulfilled") log.info("BlueBubbles reachable", { url: config.bluebubblesUrl });
  else log.error("BlueBubbles unreachable", { url: config.bluebubblesUrl, error: String(bb.reason) });
  if (rc.status === "fulfilled") log.info("Receipts reachable", { url: config.receiptsUrl });
  else log.error("Receipts unreachable", { url: config.receiptsUrl, error: String(rc.reason) });
  return results.every((result) => result.status === "fulfilled");
}

async function run(config: BridgeConfig, log: Logger): Promise<void> {
  const bluebubbles = new BlueBubblesClient({ baseUrl: config.bluebubblesUrl, password: config.bluebubblesPassword });
  const receipts = new ReceiptsApiClient({ baseUrl: config.receiptsUrl, secret: config.botSecret });
  const bridge = new Bridge({
    bluebubbles,
    receipts,
    store: new FileStateStore(config.stateFile),
    clock: Date.now,
    utcOffsetMinutes: (at) => -new Date(at).getTimezoneOffset(),
    log,
    options: {
      allowDirectChats: config.allowDirectChats,
      initialLookbackMs: config.initialLookbackMs,
      pageSize: 100,
      maxPagesPerScan: 10
    }
  });
  await bridge.start();

  const background = (label: string, work: Promise<unknown>) => {
    work.catch((error) => log.error(`${label} failed`, { error: error instanceof Error ? error.message : String(error) }));
  };

  const server = createWebhookServer({
    secret: config.webhookSecret,
    onEvent: (payload) => background("Webhook", bridge.handleWebhook(payload))
  });
  server.on("error", (error) => {
    log.error("Webhook listener failed", { error: error.message });
    process.exit(1);
  });
  server.listen(config.listenPort, config.listenHost, () => {
    log.info("Receipts bridge listening", { host: config.listenHost, port: config.listenPort, stateFile: config.stateFile });
  });

  await check(config, log);
  background("Startup sync", bridge.sync());

  let lastTick = Date.now();
  let lastCatchUp = lastTick;
  let lastReminders = lastTick;
  setInterval(() => {
    const now = Date.now();
    const slept = now - lastTick > WAKE_GAP_MS;
    lastTick = now;
    if (slept) {
      log.info("Woke up; catching up");
      lastCatchUp = now;
      lastReminders = now;
      background("Wake sync", bridge.sync());
      return;
    }
    if (now - lastCatchUp >= config.catchUpIntervalMs) {
      lastCatchUp = now;
      background("Catch-up", bridge.catchUp());
      // Blitz news is time-sensitive, so it goes out on the catch-up cadence rather than the hourly reminder one.
      background("Announcements", bridge.deliverAnnouncements());
    }
    if (now - lastReminders >= config.reminderIntervalMs) {
      lastReminders = now;
      background("Reminders", bridge.deliverReminders());
    }
  }, TICK_MS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info("Shutting down", { signal });
      server.close();
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  const log = createLogger();
  let config: BridgeConfig;
  try {
    config = readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(error.message);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }
  if (process.argv.includes("check")) {
    process.exit((await check(config, log)) ? 0 : 1);
  }
  await run(config, log);
}

void main();
