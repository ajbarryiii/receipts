// Local HTTP listener for BlueBubbles webhooks.
// POST /bluebubbles?secret=<BRIDGE_WEBHOOK_SECRET> with a JSON body; GET /health for monitoring.

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export type WebhookServerOptions = {
  secret: string;
  /** Called after the request is acknowledged. Must not throw. */
  onEvent: (payload: unknown) => void;
};

/** Responds 200 before handing the event off, so slow processing never stalls BlueBubbles. */
export function createWebhookServer(options: WebhookServerOptions): Server {
  const expected = Buffer.from(options.secret);

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const reply = (status: number, body: string) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(body);
    };

    if (request.method === "GET" && url.pathname === "/health") {
      reply(200, "ok");
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/bluebubbles") {
      reply(404, "not found");
      return;
    }
    const provided = Buffer.from(url.searchParams.get("secret") ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      reply(401, "unauthorized");
      request.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) {
        rejected = true;
        reply(413, "too large");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reply(400, "invalid json");
        return;
      }
      reply(200, "ok");
      setImmediate(() => options.onEvent(payload));
    });
  });
}
