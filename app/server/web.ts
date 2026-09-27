// Business logic behind the web app's queries and mutations.
// Every function requires a signed-in account and gates group data on membership.

import { dueAtFor, isIsoDate } from "../shared/dates";
import { maskHandle } from "../shared/format";
import { computeStandings, standingFor, takePoints } from "../shared/scoring";
import {
  isSettlementOutcome,
  OFFICIAL_STATUSES,
  type GroupView,
  type HomeView,
  type InviteView,
  type IsoDate,
  type ProfileView,
  type ReceiptCard,
  type ReceiptDetail,
  type SettlementOutcome,
  type SubjectRef
} from "../shared/types";
import type { ReadDb, ReceiptRow, WebReadCtx, WebWriteCtx } from "./db";
import {
  applyBlitzChange,
  ensureMembership,
  ensureProfile,
  getRow,
  groupMembers,
  groupReceipts,
  linkIdentity,
  creatorName,
  loadBlitz,
  loadNames,
  MAX_GROUP_RECEIPTS,
  membershipFor,
  memberNames,
  receiptByNumber,
  requireMembership,
  settleBlockReason,
  subjectDisplayName,
  subjectRefOf,
  toCard,
  toScored
} from "./model";
import { MAX_VOTES, recordHeatVote, voteBlockReason } from "./heat";
import { isTokenShaped } from "./tokens";

export const MAX_NOTES_LENGTH = 500;
export const MAX_GROUP_NAME_LENGTH = 60;

const DUE_SOON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
const TYPE_LIST_LIMIT = 20;

export async function homeView(ctx: WebReadCtx): Promise<HomeView> {
  const me = ctx.auth.requireSignedIn();
  const memberships = await ctx.db.memberships.withIndex("by_user", (q) => q.eq("userId", me.userId)).take(100);
  const groups: HomeView["groups"] = [];
  for (const membership of memberships) {
    const group = await getRow(ctx.db.groups, membership.groupId);
    if (group) {
      groups.push({ id: group.id, name: group.name, role: membership.role === "owner" ? "owner" : "member" });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { displayName: me.displayName, groups };
}

/** Null when the group does not exist or the caller is not a member. */
export async function groupView(ctx: WebReadCtx, groupId: string, now: number): Promise<GroupView | null> {
  const me = ctx.auth.requireSignedIn();
  const group = await getRow(ctx.db.groups, groupId);
  const membership = group ? await membershipFor(ctx.db, group.id, me.userId) : null;
  if (!group || !membership) {
    return null;
  }
  const members = await groupMembers(ctx.db, group.id);
  const book = await loadNames(ctx.db, group.id, members);
  const rows = await groupReceipts(ctx.db, group.id);
  const cards = rows.map((row) => toCard(row, book));
  const pending = cards.filter((card) => card.status === "pending");
  const blitz = await loadBlitz(ctx.db, group, now, book.members);

  return {
    id: group.id,
    name: group.name,
    role: membership.role === "owner" ? "owner" : "member",
    members: members.map((member) => ({ ...member, isMe: member.userId === me.userId })),
    nominations: cards.filter((card) => card.status === "nominated"),
    dueSoon: pending
      .filter((card) => card.dueAt !== null && card.dueAt <= now + DUE_SOON_WINDOW_MS)
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.number - b.number),
    pending,
    recentlySettled: settledFirst(cards).slice(0, RECENT_LIMIT),
    standings: computeStandings(rows.map((row) => toScored(row, book.members))),
    blitz: blitz && {
      phase: blitz.phase,
      startedAt: blitz.schedule.startedAt,
      endsAt: blitz.schedule.endsAt,
      anointAt: blitz.schedule.anointAt,
      board: blitz.board,
      crown: blitz.crown
    }
  };
}

/** Null when the receipt does not exist, was canceled, or the caller is not a member. */
export async function receiptDetail(ctx: WebReadCtx, groupId: string, number: number, now: number): Promise<ReceiptDetail | null> {
  const me = ctx.auth.requireSignedIn();
  const group = await getRow(ctx.db.groups, groupId);
  const membership = group ? await membershipFor(ctx.db, group.id, me.userId) : null;
  if (!group || !membership) {
    return null;
  }
  const receipt = await receiptByNumber(ctx.db, group.id, number);
  if (!receipt || receipt.status === "canceled") {
    return null;
  }
  const book = await loadNames(ctx.db, group.id);
  const names = book.members;
  const votes = await ctx.db.heatVotes.withIndex("by_receipt", (q) => q.eq("receiptId", receipt.id)).take(MAX_VOTES);
  const settlements = await ctx.db.settlements.withIndex("by_receipt", (q) => q.eq("receiptId", receipt.id)).take(50);
  const card = toCard(receipt, book);
  const settled = card.status === "right" || card.status === "wrong" || card.status === "void";
  const settleBlocked = settleBlockReason(receipt, card.subjectName, { userId: me.userId }, membership.role === "owner");

  return {
    card,
    groupName: group.name,
    originalText: receipt.originalText,
    createdByName: creatorName(receipt, book),
    dateAmbiguous: receipt.dateAmbiguous,
    votes: votes.map((vote) => ({ name: (vote.userId && names.get(vote.userId)) || (vote.identityId && book.identities.get(vote.identityId)) || "Former member", flames: vote.flames, isMine: vote.userId === me.userId })),
    myVote: votes.find((vote) => vote.userId === me.userId)?.flames ?? null,
    voteBlockedReason: voteBlockReason(receipt, card.subjectName, { userId: me.userId }, now),
    canSettle: settleBlocked === null,
    settleBlockedReason: settleBlocked,
    canEditDeadline: card.status === "pending",
    canRespond: card.status === "nominated" && receipt.subjectUserId === me.userId,
    settlements: settlements
      .sort((a, b) => a.at - b.at)
      .map((settlement) => ({
        outcome: settlement.outcome as SettlementOutcome,
        settledByName:
          (settlement.settledByUserId && names.get(settlement.settledByUserId)) ||
          (settlement.settledByIdentityId && book.identities.get(settlement.settledByIdentityId)) ||
          "Former member",
        notes: settlement.notes ?? null,
        at: settlement.at
      })),
    points: settled && card.type === "take" ? takePoints(card) : null
  };
}

/**
 * Null when the caller is not a member, or the subject has no receipts in the group
 * (members linked to an account always have a profile).
 */
export async function profileView(ctx: WebReadCtx, groupId: string, subjectRef: SubjectRef, now: number): Promise<ProfileView | null> {
  const me = ctx.auth.requireSignedIn();
  const group = await getRow(ctx.db.groups, groupId);
  const membership = group ? await membershipFor(ctx.db, group.id, me.userId) : null;
  if (!group || !membership || typeof subjectRef !== "string") {
    return null;
  }
  const book = await loadNames(ctx.db, group.id);
  const names = book.members;
  const rows = (await groupReceipts(ctx.db, group.id)).filter((row) => subjectRefOf(row) === subjectRef);
  const memberId = subjectRef.startsWith("u:") ? subjectRef.slice(2) : null;
  if (rows.length === 0 && !(memberId && names.has(memberId))) {
    return null;
  }

  const name = (memberId && names.get(memberId)) || (rows[0] ? subjectDisplayName(rows[0], names) : "Member");
  const cards = rows.map((row) => toCard(row, book));
  const official = cards.filter((card) => OFFICIAL_STATUSES.includes(card.status));
  const ofType = (type: ReceiptCard["type"]) => official.filter((card) => card.type === type).slice(0, TYPE_LIST_LIMIT);
  const correctTakes = cards
    .filter((card) => card.type === "take" && card.status === "right")
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || (b.settledAt ?? 0) - (a.settledAt ?? 0));

  return {
    groupId: group.id,
    groupName: group.name,
    subjectRef,
    name,
    isMe: subjectRef === `u:${me.userId}`,
    claimable: subjectRef.startsWith("n:"),
    crowned: ((await loadBlitz(ctx.db, group, now))?.crown ?? []).includes(subjectRef),
    standing: standingFor(subjectRef, name, rows.map((row) => toScored(row, names))),
    hottestCorrect: correctTakes[0] ?? null,
    nominations: cards.filter((card) => card.status === "nominated"),
    currentTakes: cards.filter((card) => card.type === "take" && card.status === "pending"),
    recent: settledFirst(cards).slice(0, RECENT_LIMIT),
    promises: ofType("promise"),
    bets: ofType("bet"),
    conditionals: ofType("conditional")
  };
}

/** Null for unknown tokens. */
export async function inviteView(ctx: WebReadCtx, token: string, now: number): Promise<InviteView | null> {
  const me = ctx.auth.requireSignedIn();
  const invite = await findInvite(ctx.db, token);
  const group = invite ? await getRow(ctx.db.groups, invite.groupId) : null;
  if (!invite || !group) {
    return null;
  }
  const identity = invite.kind === "join" ? await getRow(ctx.db.identities, invite.identityId) : null;
  const claimed = invite.kind === "join" &&
    (invite.usedAt !== undefined || (identity?.userId !== undefined && identity.userId !== me.userId));
  return {
    kind: invite.kind === "join" ? "join" : "invite",
    groupId: group.id,
    groupName: group.name,
    handleHint: identity ? maskHandle(identity.handle) : null,
    status: claimed ? "used" : now > invite.expiresAt ? "expired" : "valid",
    alreadyMember: (await membershipFor(ctx.db, group.id, me.userId)) !== null
  };
}

/**
 * Redeems a chat link. `join` links the sender identity to the caller and backfills their receipts;
 * `invite` adds the caller to the group. The first member of a group becomes its owner.
 */
export async function redeemInvite(ctx: WebWriteCtx, token: string, now: number): Promise<{ groupId: string }> {
  const me = ctx.auth.requireSignedIn();
  const invite = await findInvite(ctx.db, token);
  const group = invite ? await getRow(ctx.db.groups, invite.groupId) : null;
  if (!invite || !group) {
    throw new Error("This link is not valid.");
  }

  if (invite.kind === "join") {
    const identity = await getRow(ctx.db.identities, invite.identityId);
    if (!identity) {
      throw new Error("This link is not valid.");
    }
    if (invite.usedAt !== undefined) {
      if (identity.userId === me.userId) {
        return { groupId: group.id };
      }
      throw new Error("This link has already been used.");
    }
    if (now > invite.expiresAt) {
      throw new Error('This link has expired. Send "@receipts join" again.');
    }
    if (identity.userId !== undefined && identity.userId !== me.userId) {
      throw new Error("This iMessage sender is already linked to another account.");
    }
    await ensureProfile(ctx.db, me);
    await ensureMembership(ctx.db, group.id, me.userId);
    await linkIdentity(ctx.db, identity, me.userId);
    await ctx.db.invites.update(invite.id, { usedAt: now });
    return { groupId: group.id };
  }

  if (now > invite.expiresAt) {
    throw new Error('This invite has expired. Send "@receipts setup" for a new one.');
  }
  await ensureProfile(ctx.db, me);
  await ensureMembership(ctx.db, group.id, me.userId);
  return { groupId: group.id };
}

/** Records or replaces the caller's flame vote and returns the new official heat. */
export async function voteHeat(ctx: WebWriteCtx, receiptId: string, flames: number, now: number): Promise<{ heat: number | null }> {
  const me = ctx.auth.requireSignedIn();
  const receipt = await getRow(ctx.db.receipts, receiptId);
  if (!receipt || receipt.status === "canceled") {
    throw new Error("Receipt not found.");
  }
  await requireMembership(ctx.db, receipt.groupId, me.userId);
  const heat = await recordHeatVote(ctx.db, receipt, { userId: me.userId }, flames, now);
  return { heat };
}

/**
 * Settles a receipt at any time, but never by the take's author or its nominator.
 * Changing an already-settled outcome is an owner-only correction. Heat is never changed by settlement.
 */
export async function settleReceipt(
  ctx: WebWriteCtx,
  receiptId: string,
  outcome: SettlementOutcome,
  notes: string | null,
  now: number
): Promise<void> {
  const me = ctx.auth.requireSignedIn();
  const receipt = await getRow(ctx.db.receipts, receiptId);
  if (!receipt) {
    throw new Error("Receipt not found.");
  }
  const membership = await requireMembership(ctx.db, receipt.groupId, me.userId);
  if (!isSettlementOutcome(outcome)) {
    throw new Error("Outcome must be right, wrong, or void.");
  }
  const cleanNotes = typeof notes === "string" ? notes.trim() : "";
  if (cleanNotes.length > MAX_NOTES_LENGTH) {
    throw new Error(`Notes must be at most ${MAX_NOTES_LENGTH} characters.`);
  }
  const subjectName = subjectDisplayName(receipt, await memberNames(ctx.db, receipt.groupId));
  const blocked = settleBlockReason(receipt, subjectName, { userId: me.userId }, membership.role === "owner");
  if (blocked) {
    throw new Error(blocked);
  }

  const group = await getRow(ctx.db.groups, receipt.groupId);
  const blitz = group ? await applyBlitzChange(ctx.db, group, receipt, { outcome }, now) : null;
  await ctx.db.receipts.update(receipt.id, { status: outcome, settledAt: now });
  await ctx.db.settlements.insert({
    receiptId: receipt.id,
    outcome,
    settledByUserId: me.userId,
    ...(cleanNotes ? { notes: cleanNotes } : {}),
    at: now
  });
  if (blitz?.announcement) {
    // Web settlements have no chat reply to ride along with, so the crown news goes out with the next announcements.
    await ctx.db.announcements.insert({ groupId: receipt.groupId, kind: "crown", message: blitz.announcement, sendAt: now });
  }
}

/** Sets or clears the deadline of a pending receipt. Clears any sent reminder so a new date re-arms it. */
export async function setDeadline(ctx: WebWriteCtx, receiptId: string, deadline: IsoDate | null): Promise<void> {
  const me = ctx.auth.requireSignedIn();
  const receipt = await getRow(ctx.db.receipts, receiptId);
  if (!receipt) {
    throw new Error("Receipt not found.");
  }
  await requireMembership(ctx.db, receipt.groupId, me.userId);
  if (deadline !== null && !isIsoDate(deadline)) {
    throw new Error("Pick a real date.");
  }
  if (receipt.status !== "pending") {
    throw new Error("Only pending receipts can change deadlines.");
  }
  const group = await getRow(ctx.db.groups, receipt.groupId);
  await ctx.db.receipts.update(receipt.id, {
    deadline,
    dueAt: deadline === null ? null : dueAtFor(deadline, group?.utcOffsetMinutes ?? 0),
    dateAmbiguous: false,
    remindedAt: null
  });
}

/** Accepts or rejects a nomination. Only the author of the nominated message may respond. */
export async function respondToNomination(ctx: WebWriteCtx, receiptId: string, accept: boolean, now: number): Promise<void> {
  const me = ctx.auth.requireSignedIn();
  const receipt = await getRow(ctx.db.receipts, receiptId);
  if (!receipt || receipt.status === "canceled") {
    throw new Error("Receipt not found.");
  }
  await requireMembership(ctx.db, receipt.groupId, me.userId);
  if (receipt.nominatedAt === undefined) {
    throw new Error("This receipt isn't a nomination.");
  }
  if (receipt.subjectUserId !== me.userId) {
    const name = subjectDisplayName(receipt, await memberNames(ctx.db, receipt.groupId));
    throw new Error(`Only ${name} can respond to this nomination.`);
  }
  if (receipt.status === "nominated") {
    await ctx.db.receipts.update(receipt.id, accept ? { status: "pending", acceptedAt: now } : { status: "rejected", rejectedAt: now });
    return;
  }
  const alreadyRejected = receipt.status === "rejected";
  if (accept === alreadyRejected) {
    throw new Error(alreadyRejected ? "This nomination was already declined." : "This nomination was already accepted.");
  }
  // Same answer as before: nothing to change.
}

/** Claims an unclaimed chat name (`n:<key>`) as the caller and links its receipts. */
export async function claimName(ctx: WebWriteCtx, groupId: string, subjectRef: SubjectRef): Promise<{ subjectRef: SubjectRef }> {
  const me = ctx.auth.requireSignedIn();
  const group = await getRow(ctx.db.groups, groupId);
  if (!group) {
    throw new Error("Group not found.");
  }
  await requireMembership(ctx.db, group.id, me.userId);
  if (typeof subjectRef !== "string" || !subjectRef.startsWith("n:")) {
    throw new Error("Only chat names can be claimed.");
  }
  const key = subjectRef.slice(2);
  const existingClaim = await ctx.db.nameClaims.withIndex("by_group_name", (q) => q.eq("groupId", group.id).eq("nameKey", key)).first();
  const unclaimed = (
    await ctx.db.receipts
      .withIndex("by_group_subject_key", (q) => q.eq("groupId", group.id).eq("subjectKey", key))
      .take(MAX_GROUP_RECEIPTS)
  ).filter((row) => !row.subjectUserId && !row.subjectIdentityId && row.status !== "canceled");
  if (existingClaim || unclaimed.length === 0) {
    throw new Error("No unclaimed receipts under that name.");
  }

  await ensureProfile(ctx.db, me);
  await ctx.db.nameClaims.insert({ groupId: group.id, nameKey: key, userId: me.userId });
  for (const receipt of unclaimed) {
    await ctx.db.receipts.update(receipt.id, { subjectUserId: me.userId });
  }
  return { subjectRef: `u:${me.userId}` };
}

export async function renameGroup(ctx: WebWriteCtx, groupId: string, name: string): Promise<void> {
  const me = ctx.auth.requireSignedIn();
  const group = await getRow(ctx.db.groups, groupId);
  if (!group) {
    throw new Error("Group not found.");
  }
  await requireMembership(ctx.db, group.id, me.userId);
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!clean || clean.length > MAX_GROUP_NAME_LENGTH) {
    throw new Error(`Group name must be 1 to ${MAX_GROUP_NAME_LENGTH} characters.`);
  }
  await ctx.db.groups.update(group.id, { name: clean });
}

// --- Helpers ---------------------------------------------------------------


function settledFirst(cards: ReceiptCard[]): ReceiptCard[] {
  return cards
    .filter((card) => card.status === "right" || card.status === "wrong" || card.status === "void")
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0) || b.number - a.number);
}

async function findInvite(db: ReadDb, token: string) {
  if (!isTokenShaped(token)) {
    return null;
  }
  return db.invites.withIndex("by_token", (q) => q.eq("token", token.toUpperCase())).first();
}
