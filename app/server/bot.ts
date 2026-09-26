// Business logic behind the bridge's /api/bot/* endpoints.

import type { DueAnnouncement, DueReminder, IncomingMessage, IncomingMessageResult } from "../shared/bot-api";
import { BLITZ_TAKE_CAP, blitzPoints, blitzSchedule, CALLOUT_POINTS, defaultBlitzDeadline, type BlitzSchedule } from "../shared/blitz";
import { dueAtFrom, findDeadline, formatDate, localDate } from "../shared/dates";
import {
  acceptedMessage,
  anointedMessage,
  blitzOverMessage,
  blitzStartMessage,
  blitzStatusMessage,
  blitzTakeMessage,
  canceledMessage,
  confirmationMessage,
  crownedName,
  exposedMessage,
  helpMessage,
  joinMessage,
  lastCallMessage,
  nominationMessage,
  outcomeLabel,
  receiptDetailMessage,
  receiptListMessage,
  rejectedMessage,
  reminderMessage,
  renamedMessage,
  settledMessage,
  setupMessage,
  toldYouSoMessage,
  type BlitzTakeResult,
  type BlitzTimes
} from "../shared/format";
import { inferReceiptType, nameKey, parseBotMessage, type BotCommand, type ReceiptDraft } from "../shared/parse";
import { takePoints } from "../shared/scoring";
import type { Callout, IsoDate, ReceiptType, SettlementOutcome, SubjectRef } from "../shared/types";
import type { BotCtx, BotReadCtx, GroupRow, IdentityRow, ReadDb, ReceiptRow, WriteDb } from "./db";
import {
  adoptAlias,
  adoptNamedReceipts,
  applyBlitzChange,
  blitzTakes,
  crownNames,
  getRow,
  groupReceipts,
  groupUrl,
  identityByAlias,
  identityName,
  identityRef,
  loadBlitz,
  loadCrown,
  MAX_GROUP_RECEIPTS,
  receiptByNumber,
  receiptUrl,
  renameSubject,
  settleBlockReason,
  toChatReceipt
} from "./model";
import { randomToken } from "./tokens";

export type BotOptions = {
  /** Public web origin used in links, e.g. "https://receipts.lakebed.app". */
  appUrl: string;
  now: number;
};

/** Join links (identity claims) expire quickly because they are posted in a shared chat. */
export const JOIN_LINK_TTL_MS = 15 * 60 * 1000;
/** Group invite links from "@receipts setup". */
export const INVITE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Creators can cancel their own receipt for this long after logging it. */
export const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Informational commands older than this (bridge catch-up) get no reply. */
export const STALE_COMMAND_MS = 6 * 60 * 60 * 1000;
export const MAX_REMINDERS_PER_POLL = 20;
export const MAX_ANNOUNCEMENTS_PER_POLL = 20;

/** Take Blitz news "@receipts lfg" schedules, in the order it goes out. Each supersedes the ones before it. */
const SCHEDULED_ANNOUNCEMENTS = ["blitz_over", "last_call", "anointed"] as const;
type ScheduledAnnouncement = (typeof SCHEDULED_ANNOUNCEMENTS)[number];

const MAX_ORIGINAL_TEXT_LENGTH = 500;
/** Captured iMessages are stored as sent, up to this length. */
const MAX_CAPTURED_TEXT_LENGTH = 1000;
const LIST_LIMIT = 10;
const UPCOMING_LIMIT = 5;

type CommandContext = {
  db: WriteDb;
  group: GroupRow;
  identity: IdentityRow;
  message: IncomingMessage;
  today: IsoDate;
  stale: boolean;
  options: BotOptions;
  /** Who wears the Take Blitz crown when the command arrives. */
  crown: ReadonlySet<SubjectRef>;
};

/**
 * Handles one incoming chat message. Idempotent on `messageGuid`:
 * a repeat returns `duplicate` with the stored reply until that reply is acknowledged.
 */
export async function handleIncomingMessage(ctx: BotCtx, message: IncomingMessage, options: BotOptions): Promise<IncomingMessageResult> {
  const { db } = ctx;
  const seen = await db.processedMessages.withIndex("by_guid", (q) => q.eq("messageGuid", message.messageGuid)).first();
  if (seen) {
    return { status: "duplicate", reply: seen.reply ?? null };
  }

  const today = localDate(message.sentAt, message.utcOffsetMinutes);
  const command = parseBotMessage(message.text, today, { isReply: message.replyTo !== null });
  if (command.kind === "none") {
    // Not for us: store nothing about it.
    return { status: "ignored", reply: null };
  }

  const group = await ensureGroup(db, message);
  const identity = await ensureIdentity(db, group.id, message.senderHandle);
  const stale = options.now - message.sentAt > STALE_COMMAND_MS;
  const crown = await loadCrown(db, group, options.now);
  const reply = await runCommand(command, { db, group, identity, message, today, stale, options, crown });

  await db.processedMessages.insert({
    messageGuid: message.messageGuid,
    groupId: group.id,
    ...(reply === null ? { repliedAt: options.now } : { reply })
  });
  ctx.log.info("chat command", { kind: command.kind, groupId: group.id, replied: reply !== null });
  return { status: "processed", reply };
}

/** Marks a reply as delivered and drops its stored text. Returns false for an unknown message. */
export async function acknowledgeReply(ctx: BotCtx, messageGuid: string, now: number): Promise<boolean> {
  const ledger = await ctx.db.processedMessages.withIndex("by_guid", (q) => q.eq("messageGuid", messageGuid)).first();
  if (!ledger) {
    return false;
  }
  if (ledger.repliedAt === undefined || ledger.reply !== undefined) {
    await ctx.db.processedMessages.update(ledger.id, { reply: null, repliedAt: ledger.repliedAt ?? now });
  }
  return true;
}

/** Pending receipts whose deadline has passed and whose reminder has not been acknowledged. */
export async function listDueReminders(ctx: BotReadCtx, options: BotOptions): Promise<DueReminder[]> {
  const due = await ctx.db.receipts
    .withIndex("by_due", (q) => q.eq("status", "pending").eq("remindedAt", null).lte("dueAt", options.now))
    .take(MAX_REMINDERS_PER_POLL);
  const groups = new Map<string, { group: GroupRow; crown: ReadonlySet<SubjectRef> } | null>();
  const reminders: DueReminder[] = [];
  for (const receipt of due) {
    if (!groups.has(receipt.groupId)) {
      const group = await getRow(ctx.db.groups, receipt.groupId);
      groups.set(receipt.groupId, group ? { group, crown: await loadCrown(ctx.db, group, options.now) } : null);
    }
    const entry = groups.get(receipt.groupId);
    if (!entry) continue;
    reminders.push({
      receiptId: receipt.id,
      chatGuid: entry.group.chatGuid,
      message: reminderMessage(toChatReceipt(receipt, entry.crown), receiptUrl(options.appUrl, entry.group.id, receipt.number))
    });
  }
  return reminders;
}

/** Records that a reminder was delivered. Idempotent. Returns false for an unknown receipt. */
export async function markReminded(ctx: BotCtx, receiptId: string, now: number): Promise<boolean> {
  const receipt = await getRow(ctx.db.receipts, receiptId);
  if (!receipt) {
    return false;
  }
  if (receipt.remindedAt === undefined) {
    await ctx.db.receipts.update(receipt.id, { remindedAt: now });
  }
  return true;
}

/**
 * Group announcements ready to go out, oldest first. Scheduled Take Blitz news is worded from the group's current
 * state; anything a later due blitz announcement supersedes is left out.
 */
export async function listDueAnnouncements(ctx: BotReadCtx, options: BotOptions): Promise<DueAnnouncement[]> {
  const due = await ctx.db.announcements
    .withIndex("by_due", (q) => q.eq("sentAt", null).lte("sendAt", options.now))
    .take(MAX_ANNOUNCEMENTS_PER_POLL * 5);
  const latestScheduled = new Map<string, number>();
  for (const row of due) {
    if (isScheduled(row.kind)) {
      latestScheduled.set(row.groupId, Math.max(latestScheduled.get(row.groupId) ?? 0, row.sendAt));
    }
  }
  const current = due.filter((row) => row.sendAt >= (latestScheduled.get(row.groupId) ?? 0)).slice(0, MAX_ANNOUNCEMENTS_PER_POLL);

  const groups = new Map<string, GroupRow | null>();
  const announcements: DueAnnouncement[] = [];
  for (const row of current) {
    if (!groups.has(row.groupId)) {
      groups.set(row.groupId, await getRow(ctx.db.groups, row.groupId));
    }
    const group = groups.get(row.groupId);
    const message = group && (row.message ?? (isScheduled(row.kind) ? await scheduledMessage(ctx.db, group, row.kind, options) : null));
    if (group && message) {
      announcements.push({ announcementId: row.id, chatGuid: group.chatGuid, message });
    }
  }
  return announcements;
}

/**
 * Records that an announcement was delivered, along with anything it superseded. Idempotent.
 * Returns false for an unknown announcement.
 */
export async function markAnnounced(ctx: BotCtx, announcementId: string, now: number): Promise<boolean> {
  const { db } = ctx;
  const announcement = await getRow(db.announcements, announcementId);
  if (!announcement) {
    return false;
  }
  if (announcement.sentAt === undefined) {
    await db.announcements.update(announcement.id, { sentAt: now });
  }
  if (isScheduled(announcement.kind)) {
    // A blitz nobody played in has nothing left to announce.
    const nobodyPlayed =
      announcement.kind === "blitz_over" && (await blitzTakes(db, announcement.groupId)).every((row) => row.status === "canceled");
    const unsent = await db.announcements
      .withIndex("by_group_due", (q) => q.eq("groupId", announcement.groupId).eq("sentAt", null))
      .take(MAX_ANNOUNCEMENTS_PER_POLL * 5);
    for (const row of unsent) {
      if (row.id !== announcement.id && (nobodyPlayed || row.sendAt < announcement.sendAt)) {
        await db.announcements.update(row.id, { sentAt: now });
      }
    }
  }
  return true;
}

function isScheduled(kind: string): kind is ScheduledAnnouncement {
  return (SCHEDULED_ANNOUNCEMENTS as readonly string[]).includes(kind);
}

/** Words scheduled Take Blitz news from the blitz as it stands now. */
async function scheduledMessage(db: ReadDb, group: GroupRow, kind: ScheduledAnnouncement, options: BotOptions): Promise<string | null> {
  const blitz = await loadBlitz(db, group, options.now);
  if (!blitz) {
    return null;
  }
  const times = blitzTimes(blitz.schedule, group.utcOffsetMinutes);
  const url = groupUrl(options.appUrl, group.id);
  switch (kind) {
    case "blitz_over":
      return blitzOverMessage(blitz, times, url);
    case "last_call":
      return lastCallMessage(blitz, blitz.takes.filter((row) => row.status === "pending").map((row) => row.number), times, url);
    case "anointed":
      return anointedMessage(blitz, url);
  }
}

function blitzTimes(schedule: BlitzSchedule, utcOffsetMinutes: number): BlitzTimes {
  return { endsAt: schedule.endsAt, anointAt: schedule.anointAt, utcOffsetMinutes };
}

// --- Commands --------------------------------------------------------------

async function runCommand(command: Exclude<BotCommand, { kind: "none" }>, context: CommandContext): Promise<string | null> {
  const { db, group, identity, stale, options, crown } = context;
  const chat = (row: ReceiptRow) => toChatReceipt(row, crown);
  const url = groupUrl(options.appUrl, group.id);

  switch (command.kind) {
    case "create":
      return createReceipt(command.draft, context);

    case "capture":
      return captureReceipt(command, context);

    case "cancel":
      return cancelReceipt(command.number, context);

    case "accept":
    case "reject":
      return respondToNomination(command.number, command.kind === "accept", context);

    case "settle":
      return settleInChat(command.number, command.outcome, context);

    case "rename":
      return renameSender(command.name, context);

    case "join": {
      const token = await createInvite(db, { kind: "join", groupId: group.id, identityId: identity.id, ttl: JOIN_LINK_TTL_MS, now: options.now });
      return joinMessage(`${options.appUrl}/join/${token}`, JOIN_LINK_TTL_MS / 60_000);
    }

    case "setup": {
      const token = await createInvite(db, { kind: "invite", groupId: group.id, ttl: INVITE_LINK_TTL_MS, now: options.now });
      return setupMessage(group.name, `${options.appUrl}/join/${token}`, INVITE_LINK_TTL_MS / 86_400_000);
    }

    case "lfg":
      return startBlitz(context);

    case "exposed":
      return calloutReceipt("exposed", context);

    case "toldYouSo":
      return calloutReceipt("told_you_so", context);

    case "invalid":
      return `🧾 ${command.reason}`;
  }

  // Everything below only reads. Late answers to questions nobody is waiting for are noise.
  if (stale) {
    return null;
  }

  switch (command.kind) {
    case "help":
      return helpMessage(url);

    case "list": {
      const pending = (await groupReceipts(db, group.id)).filter((row) => row.status === "pending").slice(0, LIST_LIMIT);
      return receiptListMessage("PENDING", pending.map(chat), url, "Nothing pending. Log one with @receipts #take.");
    }

    case "upcoming": {
      const upcoming = (await groupReceipts(db, group.id))
        .filter((row) => row.status === "pending" && row.dueAt !== undefined)
        .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.number - b.number)
        .slice(0, UPCOMING_LIMIT);
      return receiptListMessage("UPCOMING", upcoming.map(chat), url, "Nothing with a due date yet.");
    }

    case "mine": {
      if (!identity.userId) {
        return '🧾 I don\'t know who you are yet. Link your profile with "@receipts join".';
      }
      const mine = (await groupReceipts(db, group.id))
        .filter((row) => row.status === "pending" && row.subjectUserId === identity.userId)
        .slice(0, LIST_LIMIT);
      return receiptListMessage("YOUR PENDING RECEIPTS", mine.map(chat), url, "Nothing pending about you. Suspicious.");
    }

    case "nominations": {
      const open = (await groupReceipts(db, group.id)).filter((row) => row.status === "nominated").slice(0, LIST_LIMIT);
      return receiptListMessage("NOMINATIONS", open.map(chat), url, "No open nominations.");
    }

    case "show": {
      const receipt = await receiptByNumber(db, group.id, command.number);
      if (!receipt) return `🧾 No receipt #${command.number} here.`;
      if (receipt.status === "canceled") return `🧾 Receipt #${command.number} was canceled.`;
      return receiptDetailMessage(chat(receipt), receiptUrl(options.appUrl, group.id, receipt.number));
    }

  }
}

/** "@receipts lfg": starts the group's one Take Blitz, or says where it stands. */
async function startBlitz(context: CommandContext): Promise<string> {
  const { db, group, message, options } = context;
  const existing = await loadBlitz(db, group, options.now);
  if (existing) {
    return blitzStatusMessage(existing.phase, blitzTimes(existing.schedule, group.utcOffsetMinutes), crownNames(existing));
  }
  // Catch-up must use the same message clock as entries, or takes queued after lfg all predate the window.
  const schedule = blitzSchedule(message.sentAt);
  await db.groups.update(group.id, { blitzStartedAt: schedule.startedAt });
  const sendAt: Record<ScheduledAnnouncement, number> = {
    blitz_over: schedule.endsAt,
    last_call: schedule.lastCallAt,
    anointed: schedule.anointAt
  };
  for (const kind of SCHEDULED_ANNOUNCEMENTS) {
    await db.announcements.insert({ groupId: group.id, kind, sendAt: sendAt[kind] });
  }
  const token = await createInvite(db, { kind: "invite", groupId: group.id, ttl: INVITE_LINK_TTL_MS, now: options.now });
  return blitzStartMessage(blitzTimes(schedule, group.utcOffsetMinutes), {
    url: `${options.appUrl}/join/${token}`,
    expiresInDays: INVITE_LINK_TTL_MS / 86_400_000
  });
}

/** The blitz a message was sent during, if any. */
function liveBlitz(group: GroupRow, sentAt: number): BlitzSchedule | null {
  if (group.blitzStartedAt === undefined) {
    return null;
  }
  const schedule = blitzSchedule(group.blitzStartedAt);
  return sentAt >= schedule.startedAt && sentAt < schedule.endsAt ? schedule : null;
}

/**
 * What something the sender puts up during the blitz earns (`points` when it has room, 0 when it's too late),
 * counting everything they've put up so far against the cap. Exposés use a slot but earn the sender nothing.
 */
async function scoreBlitzEntry(
  context: CommandContext,
  points: number,
  earnsForSender: boolean
): Promise<BlitzTakeResult> {
  const { db, group, identity, options } = context;
  const blitz = await loadBlitz(db, group, options.now);
  const used = blitz?.takes.filter((row) => row.createdByIdentityId === identity.id && row.status !== "canceled").length ?? 0;
  const total = blitz?.board.find((standing) => standing.subjectRef === identityRef(identity))?.total ?? 0;
  const left = BLITZ_TAKE_CAP - used;
  if (left <= 0) {
    return { points: 0, total, left: 0, blocked: "cap" };
  }
  if (points === 0) {
    return { points: 0, total, left, blocked: "late" };
  }
  return { points, total: earnsForSender ? total + points : total, left: left - 1, blocked: null };
}

async function createReceipt(draft: ReceiptDraft, context: CommandContext): Promise<string> {
  const { db, group, identity, message, today, stale, options, crown } = context;

  let subjectName: string;
  let subjectUserId: string | undefined;
  let subjectIdentityId: string | undefined;
  if (draft.subject.kind === "sender") {
    subjectName = await identityName(db, identity);
    subjectUserId = identity.userId;
    subjectIdentityId = identity.id;
  } else {
    subjectName = draft.subject.name;
    const key = nameKey(subjectName);
    const aliased = await identityByAlias(db, group.id, key);
    if (aliased) {
      subjectName = aliased.displayAlias ?? subjectName;
      subjectIdentityId = aliased.id;
      subjectUserId = aliased.userId;
    } else {
      const claim = await db.nameClaims.withIndex("by_group_name", (q) => q.eq("groupId", group.id).eq("nameKey", key)).first();
      subjectUserId = claim?.userId;
    }
  }

  // During the blitz, everything people say about themselves is a take, due by the end of the week unless dated.
  const blitz = subjectIdentityId === identity.id ? liveBlitz(group, message.sentAt) : null;
  let { type, deadline } = draft;
  if (blitz && !deadline && (type === "take" || (type === "generic" && !draft.typeExplicit))) {
    type = "take";
    deadline = { date: defaultBlitzDeadline(blitz, message.utcOffsetMinutes), ambiguous: false };
  }

  const duplicate = await findOpenDuplicate(db, group.id, subjectName, draft.statement, deadline?.date ?? null);
  if (duplicate) {
    return `🧾 That's already Receipt #${duplicate.number}.`;
  }

  const dueAt = deadline ? dueAtFrom(deadline.date, message.utcOffsetMinutes, message.sentAt) : null;
  const scored =
    blitz && type === "take" && deadline && dueAt !== null
      ? await scoreBlitzEntry(context, blitzPoints({ deadline: deadline.date, dueAt }, today, blitz), true)
      : null;

  const number = group.nextNumber;
  await db.groups.update(group.id, { nextNumber: number + 1 });
  const receipt = await db.receipts.insert({
    groupId: group.id,
    number,
    type,
    status: "pending",
    subjectName,
    subjectKey: nameKey(subjectName),
    ...(subjectUserId ? { subjectUserId } : {}),
    ...(subjectIdentityId ? { subjectIdentityId } : {}),
    ...(identity.userId ? { createdByUserId: identity.userId } : {}),
    createdByIdentityId: identity.id,
    capture: "manual",
    statement: draft.statement,
    originalText: message.text.trim().slice(0, MAX_ORIGINAL_TEXT_LENGTH),
    commandMessageGuid: message.messageGuid,
    madeOn: today,
    madeAt: message.sentAt,
    loggedAt: options.now,
    ...(deadline && dueAt !== null ? { deadline: deadline.date, dueAt, dateAmbiguous: deadline.ambiguous } : {}),
    ...(scored && scored.points > 0 ? { blitzPoints: scored.points } : {})
  });
  if (scored) {
    return blitzTakeMessage(toChatReceipt(receipt, crown), scored, { late: stale });
  }
  return confirmationMessage(toChatReceipt(receipt, crown), { today, late: stale });
}

async function cancelReceipt(number: number, context: CommandContext): Promise<string> {
  const { db, group, identity, options } = context;
  const receipt = await receiptByNumber(db, group.id, number);
  if (!receipt) {
    return `🧾 No receipt #${number} here.`;
  }
  if (receipt.status === "canceled") {
    return `🧾 Receipt #${number} is already canceled.`;
  }
  if (receipt.status === "rejected") {
    return `🧾 ${receipt.subjectName} already declined #${number}.`;
  }
  if (receipt.status !== "pending" && receipt.status !== "nominated") {
    return `🧾 Receipt #${number} is already settled.`;
  }
  if (receipt.createdByIdentityId !== identity.id) {
    return `🧾 Only whoever logged #${number} can cancel it. Receipts are receipts.`;
  }
  if (options.now - receipt.loggedAt > CANCEL_WINDOW_MS) {
    return `🧾 Too late: receipts are permanent after 24 hours. Someone else can settle it as void: "@receipts ${number} void".`;
  }
  const blitz = await applyBlitzChange(db, group, receipt, "canceled", options.now);
  await db.receipts.update(receipt.id, { status: "canceled" });
  return withAnnouncement(canceledMessage(number), blitz?.announcement ?? null);
}

function withAnnouncement(reply: string, announcement: string | null): string {
  return announcement ? `${reply}\n\n${announcement}` : reply;
}

/**
 * Records the message a native reply points at. Replying to someone else's message nominates it;
 * replying to your own puts it on the record immediately.
 */
async function captureReceipt(command: Extract<BotCommand, { kind: "capture" }>, context: CommandContext): Promise<string> {
  const { db, group, identity, message, today, stale, options, crown } = context;
  const source = message.replyTo;
  const statement = source?.text.trim().slice(0, MAX_CAPTURED_TEXT_LENGTH) ?? "";
  if (!source || !statement) {
    return "🧾 I can only capture text messages. Reply to one with @receipts #take by Apr 15 2027.";
  }

  // iMessage only records a thread's first message, so a reply inside a busy thread may mean any of them.
  if (source.ambiguous) {
    const due = command.deadline ? formatDate(command.deadline.date).replace(",", "") : "Apr 15 2027";
    return `🧾 That thread has other replies, so I can't tell which message you mean. Spell it out: @receipts #${command.type ?? "take"} <name>: <the take> by ${due}`;
  }

  const existing = (
    await db.receipts
      .withIndex("by_group_source", (q) => q.eq("groupId", group.id).eq("sourceMessageGuid", source.messageGuid))
      .take(10)
  ).find((row) => row.status !== "canceled");
  if (existing) {
    return alreadyCapturedMessage(existing, identity);
  }

  const saidOn = localDate(source.sentAt, message.utcOffsetMinutes);
  const quoted = command.deadline ? null : findDeadline(statement, saidOn);
  let deadline = command.deadline ?? (quoted ? { date: quoted.date, ambiguous: quoted.ambiguous } : null);
  let type = command.type ?? inferReceiptType(statement, deadline !== null);
  const author = await ensureIdentity(db, group.id, source.authorHandle);
  const authorName = await identityName(db, author);
  const selfCapture = author.id === identity.id || (author.userId !== undefined && author.userId === identity.userId);
  const blitz = selfCapture ? liveBlitz(group, message.sentAt) : null;
  if (blitz && !deadline && (type === "take" || (type === "generic" && command.type === null))) {
    type = "take";
    deadline = { date: defaultBlitzDeadline(blitz, message.utcOffsetMinutes), ambiguous: false };
  }
  if (!deadline && type !== "generic") {
    return `🧾 By when? Reply to that message again with "@receipts #${type} by Apr 15 2027".`;
  }

  const duplicate = await findOpenDuplicate(db, group.id, authorName, statement, deadline?.date ?? null);
  if (duplicate) {
    return alreadyCapturedMessage(duplicate, identity);
  }

  const dueAt = deadline ? dueAtFrom(deadline.date, message.utcOffsetMinutes, message.sentAt) : null;
  const scored =
    blitz && type === "take" && deadline && dueAt !== null
      ? await scoreBlitzEntry(context, blitzPoints({ deadline: deadline.date, dueAt }, today, blitz), true)
      : null;
  const number = group.nextNumber;
  await db.groups.update(group.id, { nextNumber: number + 1 });
  const receipt = await db.receipts.insert({
    groupId: group.id,
    number,
    type,
    status: selfCapture ? "pending" : "nominated",
    capture: "reply",
    subjectName: authorName,
    subjectKey: nameKey(authorName),
    ...(author.userId ? { subjectUserId: author.userId } : {}),
    subjectIdentityId: author.id,
    ...(identity.userId ? { createdByUserId: identity.userId } : {}),
    createdByIdentityId: identity.id,
    statement,
    originalText: message.text.trim().slice(0, MAX_ORIGINAL_TEXT_LENGTH),
    commandMessageGuid: message.messageGuid,
    sourceMessageGuid: source.messageGuid,
    sourceSentAt: source.sentAt,
    madeOn: saidOn,
    madeAt: source.sentAt,
    loggedAt: options.now,
    ...(deadline && dueAt !== null ? { deadline: deadline.date, dueAt, dateAmbiguous: deadline.ambiguous } : {}),
    ...(selfCapture ? {} : { nominatedAt: options.now }),
    ...(scored && scored.points > 0 ? { blitzPoints: scored.points } : {})
  });

  if (scored) {
    return blitzTakeMessage(toChatReceipt(receipt, crown), scored, { late: stale });
  }
  if (selfCapture) {
    return confirmationMessage(toChatReceipt(receipt, crown), { today, late: stale });
  }
  return nominationMessage(toChatReceipt(receipt, crown), { nominatorName: await crownedIdentityName(context, identity), today, late: stale });
}

/** How the bot names a sender, with the crown when they wear it. */
async function crownedIdentityName(context: CommandContext, identity: IdentityRow): Promise<string> {
  return crownedName(await identityName(context.db, identity), context.crown.has(identityRef(identity)));
}

/**
 * "@receipts exposed" (replying to someone else's message) and "@receipts told you so" (replying to your own):
 * puts the old message on the record right away as a take by its author, with no deadline, for the group to settle.
 * During the blitz each one puts CALLOUT_POINTS at stake: against the exposed author, or for whoever called it.
 */
async function calloutReceipt(callout: Callout, context: CommandContext): Promise<string> {
  const { db, group, identity, message, stale, options, crown } = context;
  const source = message.replyTo;
  const statement = source?.text.trim().slice(0, MAX_CAPTURED_TEXT_LENGTH) ?? "";
  if (!source || !statement) {
    return callout === "exposed"
      ? '🧾 Reply to the message you want to expose with "@receipts exposed".'
      : '🧾 Reply to your own message with "@receipts told you so".';
  }
  if (source.ambiguous) {
    return "🧾 That thread has other replies, so I can't tell which message you mean.";
  }

  const existing = (
    await db.receipts
      .withIndex("by_group_source", (q) => q.eq("groupId", group.id).eq("sourceMessageGuid", source.messageGuid))
      .take(10)
  ).find((row) => row.status !== "canceled");
  if (existing) {
    return alreadyCapturedMessage(existing, identity);
  }

  const author = await ensureIdentity(db, group.id, source.authorHandle);
  const own = author.id === identity.id || (author.userId !== undefined && author.userId === identity.userId);
  if (callout === "exposed" && own) {
    return '🧾 You can\'t expose yourself. If you called it, reply to it with "@receipts told you so".';
  }
  if (callout === "told_you_so" && !own) {
    return '🧾 That\'s not your message. To call someone out, reply to it with "@receipts exposed".';
  }
  const authorName = await identityName(db, author);
  const duplicate = await findOpenDuplicate(db, group.id, authorName, statement, null);
  if (duplicate) {
    return alreadyCapturedMessage(duplicate, identity);
  }

  const scored = liveBlitz(group, message.sentAt) ? await scoreBlitzEntry(context, CALLOUT_POINTS, callout === "told_you_so") : null;
  const number = group.nextNumber;
  await db.groups.update(group.id, { nextNumber: number + 1 });
  const receipt = await db.receipts.insert({
    groupId: group.id,
    number,
    type: "take",
    status: "pending",
    capture: "reply",
    callout,
    subjectName: authorName,
    subjectKey: nameKey(authorName),
    ...(author.userId ? { subjectUserId: author.userId } : {}),
    subjectIdentityId: author.id,
    ...(identity.userId ? { createdByUserId: identity.userId } : {}),
    createdByIdentityId: identity.id,
    statement,
    originalText: message.text.trim().slice(0, MAX_ORIGINAL_TEXT_LENGTH),
    commandMessageGuid: message.messageGuid,
    sourceMessageGuid: source.messageGuid,
    sourceSentAt: source.sentAt,
    madeOn: localDate(source.sentAt, message.utcOffsetMinutes),
    madeAt: source.sentAt,
    loggedAt: options.now,
    ...(scored && scored.points > 0 ? { blitzPoints: scored.points } : {})
  });

  if (callout === "exposed") {
    return exposedMessage(toChatReceipt(receipt, crown), { exposerName: await crownedIdentityName(context, identity), blitz: scored, late: stale });
  }
  return toldYouSoMessage(toChatReceipt(receipt, crown), { blitz: scored, late: stale });
}

/** "@receipts accept 43" / "@receipts reject 43": only the nominated message's author may answer. */
async function respondToNomination(number: number, accept: boolean, context: CommandContext): Promise<string> {
  const { db, group, identity, options, crown } = context;
  const receipt = await receiptByNumber(db, group.id, number);
  if (!receipt) {
    return `🧾 No receipt #${number} here.`;
  }
  if (receipt.status === "canceled") {
    return `🧾 Receipt #${number} was canceled.`;
  }
  if (receipt.nominatedAt === undefined) {
    return `🧾 #${number} isn't a nomination. It's already on the record.`;
  }
  if (receipt.status === "rejected") {
    return `🧾 ${receipt.subjectName} already declined #${number}.`;
  }
  if (receipt.status !== "nominated") {
    return `🧾 #${number} is already on the record.`;
  }
  const isAuthor =
    receipt.subjectIdentityId === identity.id || (identity.userId !== undefined && identity.userId === receipt.subjectUserId);
  if (!isAuthor) {
    return `🧾 Only ${receipt.subjectName} can ${accept ? "accept" : "reject"} #${number}.`;
  }

  if (!accept) {
    await db.receipts.update(receipt.id, { status: "rejected", rejectedAt: options.now });
    return rejectedMessage(toChatReceipt(receipt, crown));
  }
  const accepted = (await db.receipts.update(receipt.id, { status: "pending", acceptedAt: options.now })) ?? receipt;
  return acceptedMessage(toChatReceipt(accepted, crown), receiptUrl(options.appUrl, group.id, number));
}

/**
 * "@receipts 43 right": settles from chat, at any time. Never by the take's author or its nominator;
 * a settled outcome can only be corrected by the group owner on the web.
 */
async function settleInChat(number: number, outcome: SettlementOutcome, context: CommandContext): Promise<string> {
  const { db, group, identity, options } = context;
  const receipt = await receiptByNumber(db, group.id, number);
  if (!receipt) {
    return `🧾 No receipt #${number} here.`;
  }
  if (receipt.status === "right" || receipt.status === "wrong" || receipt.status === "void") {
    const settledAs = outcomeLabel(receipt.type as ReceiptType, receipt.status);
    return `🧾 #${number} is already settled as ${settledAs}. The group owner can correct it in the record book: ${receiptUrl(options.appUrl, group.id, number)}`;
  }
  const blocked = settleBlockReason(receipt, receipt.subjectName, { identityId: identity.id, userId: identity.userId }, false);
  if (blocked) {
    return `🧾 ${blocked}`;
  }

  const blitz = await applyBlitzChange(db, group, receipt, { outcome }, options.now);
  const settled = (await db.receipts.update(receipt.id, { status: outcome, settledAt: options.now })) ?? receipt;
  await db.settlements.insert({
    receiptId: receipt.id,
    outcome,
    settledByIdentityId: identity.id,
    ...(identity.userId ? { settledByUserId: identity.userId } : {}),
    at: options.now
  });
  const points = receipt.type === "take" ? takePoints({ type: "take", status: outcome, heat: receipt.heat ?? null }) : null;
  const after = { ...context, crown: blitz?.crown ?? context.crown };
  const reply = settledMessage(toChatReceipt(settled, after.crown), { outcome, settlerName: await crownedIdentityName(after, identity), points });
  return withAnnouncement(reply, blitz?.announcement ?? null);
}

/** An open receipt (nominated or pending) about the same person, saying the same thing, due the same day. */
async function findOpenDuplicate(
  db: WriteDb,
  groupId: string,
  subjectName: string,
  statement: string,
  deadline: IsoDate | null
): Promise<ReceiptRow | null> {
  const key = nameKey(subjectName);
  const said = nameKey(statement);
  const sameSubject = await db.receipts.withIndex("by_group_subject_key", (q) => q.eq("groupId", groupId).eq("subjectKey", key)).take(100);
  return (
    sameSubject.find(
      (row) =>
        (row.status === "pending" || row.status === "nominated") && nameKey(row.statement) === said && (row.deadline ?? null) === deadline
    ) ?? null
  );
}

function alreadyCapturedMessage(existing: ReceiptRow, sender: IdentityRow): string {
  const name = existing.subjectName;
  if (existing.status === "rejected") {
    return `🧾 ${name} already declined that one (#${existing.number}).`;
  }
  if (existing.status === "nominated") {
    const isAuthor = existing.subjectIdentityId === sender.id || (sender.userId !== undefined && sender.userId === existing.subjectUserId);
    return isAuthor
      ? `🧾 That's already Receipt #${existing.number}. ${name}: reply "@receipts accept ${existing.number}" to put it on the books.`
      : `🧾 That's already Receipt #${existing.number}, waiting on ${name} to accept.`;
  }
  return `🧾 That's already Receipt #${existing.number}.`;
}

/** "@receipts call me Ace": names the sender in bot messages, even without a web account. */
async function renameSender(name: string, context: CommandContext): Promise<string> {
  const { db, group, identity } = context;
  const holder = await identityByAlias(db, group.id, nameKey(name));
  if (holder && holder.id !== identity.id) {
    return `🧾 Someone here already goes by ${holder.displayAlias}. Pick another name.`;
  }
  const claim = await db.nameClaims.withIndex("by_group_name", (q) => q.eq("groupId", group.id).eq("nameKey", nameKey(name))).first();
  if (claim && claim.userId !== identity.userId) {
    return `🧾 Someone here already claimed ${name} in the record book. Pick another name, or link your account with "@receipts join" if that's you.`;
  }
  const renamed = { ...identity, displayAlias: name };
  await db.identities.update(identity.id, { displayAlias: name });
  await renameSubject(db, renamed, name);
  await adoptNamedReceipts(db, renamed, name);
  if (identity.userId) {
    await adoptAlias(db, renamed, identity.userId, true);
  }
  return renamedMessage(crownedName(name, context.crown.has(identityRef(identity))));
}

// --- Rows ------------------------------------------------------------------

async function ensureGroup(db: WriteDb, message: IncomingMessage): Promise<GroupRow> {
  const existing = await db.groups.withIndex("by_chat", (q) => q.eq("chatGuid", message.chatGuid)).first();
  if (existing) {
    if (existing.utcOffsetMinutes !== message.utcOffsetMinutes) {
      return (await db.groups.update(existing.id, { utcOffsetMinutes: message.utcOffsetMinutes })) ?? existing;
    }
    return existing;
  }
  return db.groups.insert({
    name: message.chatName ?? "Group chat",
    chatGuid: message.chatGuid,
    nextNumber: 1,
    utcOffsetMinutes: message.utcOffsetMinutes
  });
}

async function ensureIdentity(db: WriteDb, groupId: string, rawHandle: string): Promise<IdentityRow> {
  const handle = rawHandle.trim().toLowerCase();
  const existing = await db.identities.withIndex("by_group_handle", (q) => q.eq("groupId", groupId).eq("handle", handle)).first();
  return existing ?? db.identities.insert({ groupId, handle });
}

async function createInvite(
  db: WriteDb,
  invite: { kind: "join" | "invite"; groupId: string; identityId?: string; ttl: number; now: number }
): Promise<string> {
  const token = randomToken();
  await db.invites.insert({
    token,
    kind: invite.kind,
    groupId: invite.groupId,
    ...(invite.identityId ? { identityId: invite.identityId } : {}),
    expiresAt: invite.now + invite.ttl
  });
  return token;
}
