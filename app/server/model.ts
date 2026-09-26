// Row helpers shared by the bot and web modules.

import { blitzBoard, blitzPhase, blitzSchedule, crownHolders, keptPoints, type BlitzSchedule } from "../shared/blitz";
import type { BlitzResults, ChatReceipt } from "../shared/format";
import { crownChangeMessage, crownedName, maskHandle, typeLabel } from "../shared/format";
import { nameKey } from "../shared/parse";
import type { ScoredReceipt } from "../shared/scoring";
import {
  isCallout,
  type BlitzPhase,
  type BlitzStanding,
  type CalloutView,
  type CaptureMode,
  type MemberRole,
  type NominationView,
  type ReceiptCard,
  type ReceiptStatus,
  type ReceiptType,
  type SettlementOutcome,
  type SubjectRef
} from "../shared/types";
import type { AuthContext } from "lakebed/server";
import type { GroupRow, IdentityRow, MembershipRow, ReadDb, ReceiptRow, WriteDb } from "./db";

/** Upper bound on receipts loaded for one group view; keeps handlers inside Lakebed's read budget. */
export const MAX_GROUP_RECEIPTS = 500;
const MAX_MEMBERS = 60;
const MAX_IDENTITIES = 200;
/** Upper bound on point-earning blitz takes loaded for one group: 10 each for a big group chat. */
const MAX_BLITZ_TAKES = MAX_MEMBERS * 10;

export const NOT_A_MEMBER = "You're not a member of this group.";

type Gettable<T> = { get(id: string): Promise<T | null> };

/** `get` that treats malformed ids as missing. */
export async function getRow<T>(table: Gettable<T>, id: unknown): Promise<T | null> {
  if (typeof id !== "string" || !id || id.length > 100) {
    return null;
  }
  try {
    return await table.get(id);
  } catch {
    return null;
  }
}

/** The ref of receipts about this iMessage sender: their account once linked. */
export function identityRef(identity: Pick<IdentityRow, "id" | "userId">): SubjectRef {
  return identity.userId ? `u:${identity.userId}` : `i:${identity.id}`;
}

export function subjectRefOf(receipt: Pick<ReceiptRow, "subjectUserId" | "subjectIdentityId" | "subjectKey">): SubjectRef {
  if (receipt.subjectUserId) return `u:${receipt.subjectUserId}`;
  if (receipt.subjectIdentityId) return `i:${receipt.subjectIdentityId}`;
  return `n:${receipt.subjectKey}`;
}

/** Display name for a receipt's subject: the linked account's name when there is one. */
export function subjectDisplayName(receipt: ReceiptRow, names: ReadonlyMap<string, string>): string {
  return (receipt.subjectUserId && names.get(receipt.subjectUserId)) || receipt.subjectName;
}

/** Display names for a group's members (by user id) and iMessage senders (by identity id). */
export type NameBook = {
  members: ReadonlyMap<string, string>;
  identities: ReadonlyMap<string, string>;
};

export async function loadNames(db: ReadDb, groupId: string, members?: Member[]): Promise<NameBook> {
  const memberList = members ?? (await groupMembers(db, groupId));
  const byUser = new Map(memberList.map((member) => [member.userId, member.name]));
  const identities = await db.identities.withIndex("by_group_handle", (q) => q.eq("groupId", groupId)).take(MAX_IDENTITIES);
  return {
    members: byUser,
    identities: new Map(identities.map((identity) => [identity.id, nameForIdentity(identity, byUser)]))
  };
}

/** Whoever sent the "@receipts" command: for nominations, the nominator. */
export function creatorName(receipt: ReceiptRow, book: NameBook): string {
  return (
    (receipt.createdByUserId && book.members.get(receipt.createdByUserId)) ||
    (receipt.createdByIdentityId && book.identities.get(receipt.createdByIdentityId)) ||
    "Someone"
  );
}

function nominationOf(receipt: ReceiptRow, book: NameBook): NominationView | null {
  if (receipt.nominatedAt === undefined) {
    return null;
  }
  return {
    state: receipt.status === "nominated" ? "pending" : receipt.status === "rejected" ? "rejected" : "accepted",
    nominatedByName: creatorName(receipt, book),
    nominatedAt: receipt.nominatedAt
  };
}

function calloutOf(receipt: ReceiptRow, book: NameBook): CalloutView | null {
  return isCallout(receipt.callout) ? { kind: receipt.callout, byName: creatorName(receipt, book) } : null;
}

export function toCard(receipt: ReceiptRow, book: NameBook): ReceiptCard {
  return {
    id: receipt.id,
    groupId: receipt.groupId,
    number: receipt.number,
    type: receipt.type as ReceiptType,
    status: receipt.status as ReceiptStatus,
    capture: receipt.capture as CaptureMode,
    subjectRef: subjectRefOf(receipt),
    subjectName: subjectDisplayName(receipt, book.members),
    statement: receipt.statement,
    madeOn: receipt.madeOn,
    deadline: receipt.deadline ?? null,
    dueAt: receipt.dueAt ?? null,
    heat: receipt.heat ?? null,
    voteCount: receipt.voteCount,
    settledAt: receipt.settledAt ?? null,
    nomination: nominationOf(receipt, book),
    callout: calloutOf(receipt, book)
  };
}

/** `crown` holds the refs wearing the Take Blitz crown; their names get a 👑. */
export function toChatReceipt(receipt: ReceiptRow, crown: ReadonlySet<SubjectRef> = NO_CROWN): ChatReceipt {
  return {
    number: receipt.number,
    type: receipt.type as ReceiptType,
    status: receipt.status as ReceiptStatus,
    capture: receipt.capture as CaptureMode,
    subjectName: crownedName(receipt.subjectName, crown.has(subjectRefOf(receipt))),
    statement: receipt.statement,
    madeOn: receipt.madeOn,
    deadline: receipt.deadline ?? null,
    dateAmbiguous: receipt.dateAmbiguous,
    heat: receipt.heat ?? null
  };
}

export function toScored(receipt: ReceiptRow, names: ReadonlyMap<string, string>): ScoredReceipt {
  return {
    subjectRef: subjectRefOf(receipt),
    subjectName: subjectDisplayName(receipt, names),
    type: receipt.type as ReceiptType,
    status: receipt.status as ReceiptStatus,
    heat: receipt.heat ?? null
  };
}

export function groupUrl(appUrl: string, groupId: string): string {
  return `${appUrl}/g/${groupId}`;
}

export function receiptUrl(appUrl: string, groupId: string, number: number): string {
  return `${appUrl}/g/${groupId}/r/${number}`;
}

/** Non-canceled receipts in a group, newest first. */
export async function groupReceipts(db: ReadDb, groupId: string): Promise<ReceiptRow[]> {
  const rows = await db.receipts
    .withIndex("by_group_number", (q) => q.eq("groupId", groupId))
    .order("desc")
    .take(MAX_GROUP_RECEIPTS);
  return rows.filter((row) => row.status !== "canceled");
}

export async function receiptByNumber(db: ReadDb, groupId: string, number: number): Promise<ReceiptRow | null> {
  if (!Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  return db.receipts.withIndex("by_group_number", (q) => q.eq("groupId", groupId).eq("number", number)).first();
}

export async function membershipFor(db: ReadDb, groupId: string, userId: string): Promise<MembershipRow | null> {
  return db.memberships.withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", userId)).first();
}

export async function requireMembership(db: ReadDb, groupId: string, userId: string): Promise<MembershipRow> {
  const membership = await membershipFor(db, groupId, userId);
  if (!membership) {
    throw new Error(NOT_A_MEMBER);
  }
  return membership;
}

export type Member = { userId: string; name: string; avatarUrl: string | null; role: MemberRole };

export async function groupMembers(db: ReadDb, groupId: string): Promise<Member[]> {
  const memberships = await db.memberships.withIndex("by_group", (q) => q.eq("groupId", groupId)).take(MAX_MEMBERS);
  const members: Member[] = [];
  for (const membership of memberships) {
    const profile = await db.profiles.withIndex("by_user", (q) => q.eq("userId", membership.userId)).first();
    members.push({
      userId: membership.userId,
      name: membership.nickname || profile?.displayName || "Member",
      avatarUrl: profile?.avatarUrl ?? null,
      role: membership.role === "owner" ? "owner" : "member"
    });
  }
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

export async function memberNames(db: ReadDb, groupId: string): Promise<Map<string, string>> {
  return new Map((await groupMembers(db, groupId)).map((member) => [member.userId, member.name]));
}

/** Name for an iMessage sender: their "call me" alias, else their linked account's name, else a masked handle. */
function nameForIdentity(identity: IdentityRow, members: ReadonlyMap<string, string>): string {
  return identity.displayAlias || (identity.userId && members.get(identity.userId)) || maskHandle(identity.handle);
}

export async function identityName(db: ReadDb, identity: IdentityRow): Promise<string> {
  if (identity.displayAlias || !identity.userId) {
    return nameForIdentity(identity, new Map());
  }
  return nameForIdentity(identity, await memberNames(db, identity.groupId));
}

/** The sender in this group who took `key` as their "call me" name, if any. */
export async function identityByAlias(db: ReadDb, groupId: string, key: string): Promise<IdentityRow | null> {
  const identities = await db.identities.withIndex("by_group_handle", (q) => q.eq("groupId", groupId)).take(MAX_IDENTITIES);
  return identities.find((identity) => identity.displayAlias !== undefined && nameKey(identity.displayAlias) === key) ?? null;
}

/** Files receipts typed about `name` ("Riley says ...") under the sender who now goes by it. */
export async function adoptNamedReceipts(db: WriteDb, identity: IdentityRow, name: string): Promise<void> {
  const typed = await db.receipts
    .withIndex("by_group_subject_key", (q) => q.eq("groupId", identity.groupId).eq("subjectKey", nameKey(name)))
    .take(MAX_GROUP_RECEIPTS);
  for (const receipt of typed) {
    if (receipt.subjectIdentityId || receipt.subjectUserId || receipt.status === "canceled") continue;
    await db.receipts.update(receipt.id, { subjectIdentityId: identity.id, subjectName: name, ...(identity.userId ? { subjectUserId: identity.userId } : {}) });
  }
}

/** Re-labels receipts about an identity after its name changes. */
export async function renameSubject(db: WriteDb, identity: IdentityRow, name: string): Promise<void> {
  const about = await db.receipts.withIndex("by_subject_identity", (q) => q.eq("subjectIdentityId", identity.id)).take(MAX_GROUP_RECEIPTS);
  for (const receipt of about) {
    if (receipt.subjectName !== name) {
      await db.receipts.update(receipt.id, { subjectName: name, subjectKey: nameKey(name) });
    }
  }
}

/** Uses a sender's "call me" alias as their group nickname, unless they already have one. */
export async function adoptAlias(db: WriteDb, identity: IdentityRow, userId: string, overwrite: boolean): Promise<void> {
  if (!identity.displayAlias) return;
  const membership = await membershipFor(db, identity.groupId, userId);
  if (membership && (overwrite || !membership.nickname)) {
    await db.memberships.update(membership.id, { nickname: identity.displayAlias });
  }
}

/** Creates or refreshes the caller's profile from their Google identity. */
export async function ensureProfile(db: WriteDb, auth: ReturnType<AuthContext["requireSignedIn"]>): Promise<void> {
  const displayName = auth.displayName.trim().slice(0, 80) || "Member";
  const avatarUrl = auth.picture && /^https:\/\//.test(auth.picture) ? auth.picture : null;
  const existing = await db.profiles.withIndex("by_user", (q) => q.eq("userId", auth.userId)).first();
  if (!existing) {
    await db.profiles.insert({ userId: auth.userId, displayName, ...(avatarUrl ? { avatarUrl } : {}) });
  } else if (existing.displayName !== displayName || (existing.avatarUrl ?? null) !== avatarUrl) {
    await db.profiles.update(existing.id, { displayName, avatarUrl });
  }
}

/** Adds the user to the group. The first member of a group becomes its owner. */
export async function ensureMembership(db: WriteDb, groupId: string, userId: string): Promise<void> {
  if (await membershipFor(db, groupId, userId)) {
    return;
  }
  const anyone = await db.memberships.withIndex("by_group", (q) => q.eq("groupId", groupId)).first();
  await db.memberships.insert({ groupId, userId, role: anyone ? "member" : "owner" });
}

// --- Take Blitz --------------------------------------------------------------

export const NO_CROWN: ReadonlySet<SubjectRef> = new Set();

/** A group's Take Blitz as of some moment. */
export type Blitz = {
  schedule: BlitzSchedule;
  phase: BlitzPhase;
  board: BlitzStanding[];
  crown: SubjectRef[];
  /** Point-earning blitz takes, oldest first. */
  takes: ReceiptRow[];
};

/** Point-earning blitz takes in a group, oldest first. Includes canceled ones. */
export async function blitzTakes(db: ReadDb, groupId: string): Promise<ReceiptRow[]> {
  const rows = await db.receipts.withIndex("by_group_blitz", (q) => q.eq("groupId", groupId).gt("blitzPoints", 0)).take(MAX_BLITZ_TAKES);
  return rows.sort((a, b) => a.number - b.number);
}

/** The group's Take Blitz as of `now`, or null before "@receipts lfg". `names` swaps in linked account names. */
export async function loadBlitz(
  db: ReadDb,
  group: Pick<GroupRow, "id" | "blitzStartedAt">,
  now: number,
  names?: ReadonlyMap<string, string>
): Promise<Blitz | null> {
  if (group.blitzStartedAt === undefined) {
    return null;
  }
  return scoreBlitz(group.blitzStartedAt, await blitzTakes(db, group.id), now, names);
}

/** Who wears the crown right now. Empty until the blitz window closes. */
export async function loadCrown(db: ReadDb, group: Pick<GroupRow, "id" | "blitzStartedAt">, now: number): Promise<ReadonlySet<SubjectRef>> {
  if (group.blitzStartedAt === undefined || now < blitzSchedule(group.blitzStartedAt).endsAt) {
    return NO_CROWN;
  }
  return new Set((await loadBlitz(db, group, now))?.crown);
}

/** Plain names of whoever wears the crown. */
export function crownNames(blitz: BlitzResults): string[] {
  return blitz.board.filter((standing) => blitz.crown.includes(standing.subjectRef)).map((standing) => standing.name);
}

function scoreBlitz(startedAt: number, takes: ReceiptRow[], now: number, names?: ReadonlyMap<string, string>): Blitz {
  const schedule = blitzSchedule(startedAt);
  const phase = blitzPhase(schedule, now);
  const board = blitzBoard(
    takes.map((row) => ({
      subjectRef: subjectRefOf(row),
      name: names ? subjectDisplayName(row, names) : row.subjectName,
      status: row.status as ReceiptStatus,
      points: row.blitzPoints ?? 0,
      kept: row.blitzKept ?? null,
      exposed: row.callout === "exposed"
    })),
    phase
  );
  return { schedule, phase, board, crown: crownHolders(board, phase), takes };
}

/**
 * Records a blitz take being settled or canceled. A settlement before the anointing fixes the points the take keeps;
 * nothing changes the blitz after the anointing. Call before writing the change itself.
 * Returns who wears the crown afterwards and the announcement if it changed hands, or null when this isn't a blitz
 * take the blitz still counts.
 */
export async function applyBlitzChange(
  db: WriteDb,
  group: Pick<GroupRow, "id" | "blitzStartedAt">,
  receipt: ReceiptRow,
  change: { outcome: SettlementOutcome } | "canceled",
  now: number
): Promise<{ crown: ReadonlySet<SubjectRef>; announcement: string | null } | null> {
  if (receipt.blitzPoints === undefined || group.blitzStartedAt === undefined || now >= blitzSchedule(group.blitzStartedAt).anointAt) {
    return null;
  }
  const takes = await blitzTakes(db, group.id);
  let changed: ReceiptRow;
  if (change === "canceled") {
    changed = { ...receipt, status: "canceled" };
  } else {
    const kept = keptPoints(receipt.blitzPoints, change.outcome, receipt.callout === "exposed");
    await db.receipts.update(receipt.id, { blitzKept: kept });
    changed = { ...receipt, status: change.outcome, blitzKept: kept };
  }
  const before = scoreBlitz(group.blitzStartedAt, takes, now);
  const after = scoreBlitz(
    group.blitzStartedAt,
    takes.map((row) => (row.id === receipt.id ? changed : row)),
    now
  );
  return { crown: new Set(after.crown), announcement: crownChangeMessage(crownNames(before), crownNames(after)) };
}

/** Who is trying to settle: a web account, an iMessage sender, or both. */
export type Settler = { userId?: string; identityId?: string };

/**
 * Why `settler` may not settle this receipt, or null when they may. Settlement is allowed at any time, but never by
 * the person who made the take or by whoever nominated or exposed it. Changing a settled outcome is an owner-only
 * correction.
 */
export function settleBlockReason(receipt: ReceiptRow, subjectName: string, settler: Settler, isOwner: boolean): string | null {
  const is = (userId: string | undefined, identityId: string | undefined) =>
    (settler.userId !== undefined && settler.userId === userId) || (settler.identityId !== undefined && settler.identityId === identityId);
  switch (receipt.status) {
    case "canceled":
      return "This receipt was canceled.";
    case "nominated":
      return `This can be settled once ${subjectName} has accepted it.`;
    case "rejected":
      return `${subjectName} declined this one, so there's nothing to settle.`;
  }
  if (is(receipt.subjectUserId, receipt.subjectIdentityId)) {
    return `You can't settle your own ${typeLabel(receipt.type as ReceiptType).toLowerCase()}.`;
  }
  if (receipt.nominatedAt !== undefined && is(receipt.createdByUserId, receipt.createdByIdentityId)) {
    return "You nominated this one, so someone else has to settle it.";
  }
  if (receipt.callout === "exposed" && is(receipt.createdByUserId, receipt.createdByIdentityId)) {
    return "You exposed this one, so someone else has to settle it.";
  }
  if (receipt.status !== "pending" && !isOwner) {
    return "Already settled. Only the group owner can correct it.";
  }
  return null;
}

/** Links an iMessage identity to an account and moves its receipts to that account. */
export async function linkIdentity(db: WriteDb, identity: IdentityRow, userId: string): Promise<void> {
  await db.identities.update(identity.id, { userId });
  const linked = { ...identity, userId };
  await adoptAlias(db, linked, userId, false);
  const name = await identityName(db, linked);
  const about = await db.receipts.withIndex("by_subject_identity", (q) => q.eq("subjectIdentityId", identity.id)).take(MAX_GROUP_RECEIPTS);
  for (const receipt of about) {
    await db.receipts.update(receipt.id, { subjectUserId: userId, subjectName: name, subjectKey: nameKey(name) });
  }
  const created = await db.receipts.withIndex("by_creator_identity", (q) => q.eq("createdByIdentityId", identity.id)).take(MAX_GROUP_RECEIPTS);
  for (const receipt of created) {
    await db.receipts.update(receipt.id, { createdByUserId: userId });
  }
  const settled = await db.settlements.withIndex("by_settler_identity", (q) => q.eq("settledByIdentityId", identity.id)).take(MAX_GROUP_RECEIPTS);
  for (const settlement of settled) {
    await db.settlements.update(settlement.id, { settledByUserId: userId });
  }
}
