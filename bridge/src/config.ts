// Bridge configuration from environment variables (optionally loaded from an env file).

import { join } from "node:path";

export type BridgeConfig = {
  /** Lakebed app origin, e.g. "https://receipts.lakebed.app". */
  receiptsUrl: string;
  botSecret: string;
  bluebubblesUrl: string;
  bluebubblesPassword: string;
  /** Webhook listener; loopback only by default. */
  listenHost: string;
  listenPort: number;
  /** Required in the webhook URL query (`?secret=`), since BlueBubbles does not sign webhooks. */
  webhookSecret: string;
  stateFile: string;
  allowDirectChats: boolean;
  catchUpIntervalMs: number;
  reminderIntervalMs: number;
  initialLookbackMs: number;
};

export class ConfigError extends Error {}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Required: RECEIPTS_URL, RECEIPTS_BOT_SECRET, BLUEBUBBLES_PASSWORD, BRIDGE_WEBHOOK_SECRET.
 * Optional: BLUEBUBBLES_URL (http://127.0.0.1:1234), BRIDGE_HOST (127.0.0.1), BRIDGE_PORT (8787),
 * BRIDGE_STATE_FILE (<home>/Library/Application Support/ReceiptsBridge/state.json),
 * BRIDGE_ALLOW_DIRECT_CHATS (false), BRIDGE_CATCH_UP_MINUTES (5), BRIDGE_REMINDER_MINUTES (60),
 * BRIDGE_LOOKBACK_HOURS (24).
 */
export function loadConfig(env: Record<string, string | undefined>, homeDir: string): BridgeConfig {
  const problems: string[] = [];
  const value = (name: string) => env[name]?.trim() || "";

  const required = (name: string): string => {
    const found = value(name);
    if (!found) problems.push(`${name} is required.`);
    return found;
  };

  const positive = (name: string, fallback: number): number => {
    const raw = value(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      problems.push(`${name} must be a positive number.`);
      return fallback;
    }
    return parsed;
  };

  const url = (name: string, raw: string, requireHttps: boolean): string => {
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      if (requireHttps && parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        problems.push(`${name} must use https.`);
      }
    } catch {
      problems.push(`${name} must be a full URL.`);
    }
    return raw.replace(/\/+$/, "");
  };

  const receiptsUrl = url("RECEIPTS_URL", required("RECEIPTS_URL"), true);
  const botSecret = required("RECEIPTS_BOT_SECRET");
  const bluebubblesPassword = required("BLUEBUBBLES_PASSWORD");
  const webhookSecret = required("BRIDGE_WEBHOOK_SECRET");
  const bluebubblesUrl = url("BLUEBUBBLES_URL", value("BLUEBUBBLES_URL") || "http://127.0.0.1:1234", false);
  const listenPort = positive("BRIDGE_PORT", 8787);
  if (!Number.isInteger(listenPort) || listenPort > 65535) {
    problems.push("BRIDGE_PORT must be a port number.");
  }

  const config: BridgeConfig = {
    receiptsUrl,
    botSecret,
    bluebubblesUrl,
    bluebubblesPassword,
    listenHost: value("BRIDGE_HOST") || "127.0.0.1",
    listenPort,
    webhookSecret,
    stateFile: value("BRIDGE_STATE_FILE") || join(homeDir, "Library", "Application Support", "ReceiptsBridge", "state.json"),
    allowDirectChats: value("BRIDGE_ALLOW_DIRECT_CHATS").toLowerCase() === "true",
    catchUpIntervalMs: positive("BRIDGE_CATCH_UP_MINUTES", 5) * MINUTE,
    reminderIntervalMs: positive("BRIDGE_REMINDER_MINUTES", 60) * MINUTE,
    initialLookbackMs: positive("BRIDGE_LOOKBACK_HOURS", 24) * HOUR
  };

  if (problems.length > 0) {
    throw new ConfigError(`Invalid bridge configuration:\n- ${problems.join("\n- ")}`);
  }
  return config;
}

/** Parses KEY=VALUE lines. Ignores blanks and # comments; strips matching quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let entry = line.slice(equals + 1).trim();
    const quote = entry[0];
    if ((quote === '"' || quote === "'") && entry.endsWith(quote) && entry.length >= 2) {
      entry = entry.slice(1, -1);
    }
    values[key] = entry;
  }
  return values;
}
