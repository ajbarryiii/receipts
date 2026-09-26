import { capsule, endpoint, json, mutation, query, type EndpointRequest, type EndpointResponse } from "lakebed/server";
import {
  BOT_ROUTES,
  BotApiValidationError,
  parseIncomingMessage,
  parseMessageAck,
  parseAnnouncedRequest,
  parseRemindedRequest,
  type AnnouncementsResponse,
  type DueResponse,
  type ErrorResponse,
  type OkResponse,
  type PingResponse
} from "../shared/bot-api";
import type { IsoDate, SettlementOutcome, SubjectRef } from "../shared/types";
import { acknowledgeReply, handleIncomingMessage, listDueAnnouncements, listDueReminders, markAnnounced, markReminded } from "./bot";
import type { BotCtx, BotReadCtx } from "./db";
import { bearerMatches, MIN_BOT_SECRET_LENGTH, resolveAppUrl } from "./http";
import { schema } from "./schema";
import {
  claimName,
  groupView,
  homeView,
  inviteView,
  profileView,
  receiptDetail,
  redeemInvite,
  renameGroup,
  respondToNomination,
  setDeadline,
  settleReceipt,
  voteHeat
} from "./web";

type Env = Record<string, string | undefined>;

// endpoint() handlers receive the untyped database; the rows are the same schema.
const asBot = (ctx: { db: unknown; log: BotCtx["log"] }) => ctx as BotCtx;
const asBotRead = (ctx: { db: unknown; log: BotCtx["log"] }) => ctx as BotReadCtx;

/** Rejects callers without the bridge secret. Returns null when the caller may proceed. */
function rejectUnlessBot(env: Env, req: EndpointRequest): EndpointResponse | null {
  const secret = env.RECEIPTS_BOT_SECRET;
  if (!secret || secret.length < MIN_BOT_SECRET_LENGTH) {
    return json({ error: "RECEIPTS_BOT_SECRET is not configured." } satisfies ErrorResponse, { status: 503 });
  }
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return json({ error: "Unauthorized." } satisfies ErrorResponse, { status: 401 });
  }
  return null;
}

async function readJson(req: EndpointRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BotApiValidationError("Body must be JSON.");
  }
}

function badRequest(error: unknown): EndpointResponse {
  if (error instanceof BotApiValidationError) {
    return json({ error: error.message } satisfies ErrorResponse, { status: 400 });
  }
  throw error;
}

export default capsule({
  name: "Receipts",

  // Bot endpoints authenticate with an app secret, so the app-wide sign-in policy stays off.
  // Every web handler calls ctx.auth.requireSignedIn() instead.
  auth: { requireSignIn: false },

  schema,

  queries: {
    home: query(async (ctx) => homeView(ctx)),
    group: query(async (ctx, groupId: string) => groupView(ctx, groupId, Date.now())),
    receipt: query(async (ctx, groupId: string, number: number) => receiptDetail(ctx, groupId, number, Date.now())),
    profile: query(async (ctx, groupId: string, subjectRef: SubjectRef) => profileView(ctx, groupId, subjectRef, Date.now())),
    invite: query(async (ctx, token: string) => inviteView(ctx, token, Date.now()))
  },

  mutations: {
    redeemInvite: mutation(async (ctx, token: string) => redeemInvite(ctx, token, Date.now())),
    voteHeat: mutation(async (ctx, receiptId: string, flames: number) => voteHeat(ctx, receiptId, flames, Date.now())),
    settleReceipt: mutation(async (ctx, receiptId: string, outcome: SettlementOutcome, notes: string | null) =>
      settleReceipt(ctx, receiptId, outcome, notes, Date.now())
    ),
    respondToNomination: mutation(async (ctx, receiptId: string, accept: boolean) =>
      respondToNomination(ctx, receiptId, accept, Date.now())
    ),
    setDeadline: mutation(async (ctx, receiptId: string, deadline: IsoDate | null) => setDeadline(ctx, receiptId, deadline)),
    claimName: mutation(async (ctx, groupId: string, subjectRef: SubjectRef) => claimName(ctx, groupId, subjectRef)),
    renameGroup: mutation(async (ctx, groupId: string, name: string) => renameGroup(ctx, groupId, name))
  },

  endpoints: {
    botPing: endpoint({ method: "GET", path: BOT_ROUTES.ping }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      return json({ ok: true, now: Date.now() } satisfies PingResponse);
    }),

    botMessage: endpoint({ method: "POST", path: BOT_ROUTES.message }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      try {
        const message = parseIncomingMessage(await readJson(req));
        const appUrl = resolveAppUrl(ctx.env.APP_URL, req.url);
        return json(await handleIncomingMessage(asBot(ctx), message, { appUrl, now: Date.now() }));
      } catch (error) {
        return badRequest(error);
      }
    }),

    botMessageAck: endpoint({ method: "POST", path: BOT_ROUTES.messageAck }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      try {
        const { messageGuid } = parseMessageAck(await readJson(req));
        if (!(await acknowledgeReply(asBot(ctx), messageGuid, Date.now()))) {
          return json({ error: "Unknown message." } satisfies ErrorResponse, { status: 404 });
        }
        return json({ ok: true } satisfies OkResponse);
      } catch (error) {
        return badRequest(error);
      }
    }),

    botDue: endpoint({ method: "GET", path: BOT_ROUTES.due }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      const appUrl = resolveAppUrl(ctx.env.APP_URL, req.url);
      const reminders = await listDueReminders(asBotRead(ctx), { appUrl, now: Date.now() });
      return json({ reminders } satisfies DueResponse);
    }),

    botReminded: endpoint({ method: "POST", path: BOT_ROUTES.reminded }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      try {
        const { receiptId } = parseRemindedRequest(await readJson(req));
        if (!(await markReminded(asBot(ctx), receiptId, Date.now()))) {
          return json({ error: "Unknown receipt." } satisfies ErrorResponse, { status: 404 });
        }
        return json({ ok: true } satisfies OkResponse);
      } catch (error) {
        return badRequest(error);
      }
    }),

    botAnnouncements: endpoint({ method: "GET", path: BOT_ROUTES.announcements }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      const appUrl = resolveAppUrl(ctx.env.APP_URL, req.url);
      const announcements = await listDueAnnouncements(asBotRead(ctx), { appUrl, now: Date.now() });
      return json({ announcements } satisfies AnnouncementsResponse);
    }),

    botAnnounced: endpoint({ method: "POST", path: BOT_ROUTES.announced }, async (ctx, req) => {
      const rejected = rejectUnlessBot(ctx.env, req);
      if (rejected) return rejected;
      try {
        const { announcementId } = parseAnnouncedRequest(await readJson(req));
        if (!(await markAnnounced(asBot(ctx), announcementId, Date.now()))) {
          return json({ error: "Unknown announcement." } satisfies ErrorResponse, { status: 404 });
        }
        return json({ ok: true } satisfies OkResponse);
      } catch (error) {
        return badRequest(error);
      }
    })
  }
});
