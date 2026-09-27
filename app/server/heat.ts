// Shared chat/web voting rules. Unlinked chat voters use their iMessage identity.
import { isFlameRating, medianHeat } from "../shared/scoring";
import type { ReceiptRow, WriteDb } from "./db";

export const MAX_VOTES = 200;
type Voter = { userId?: string; identityId?: string };

export function voteBlockReason(receipt: ReceiptRow, subjectName: string, voter: Voter, now: number): string | null {
  if (receipt.type !== "take") return "Only takes can be rated.";
  if (receipt.status === "nominated") return `Voting opens once ${subjectName} accepts.`;
  if (receipt.status === "rejected") return "Declined nominations aren't rated.";
  if (receipt.status !== "pending") return "Voting closed when this was settled.";
  if (receipt.dueAt !== undefined && now >= receipt.dueAt) return "Voting closed at the deadline.";
  if ((voter.userId && receipt.subjectUserId === voter.userId) ||
      (voter.identityId && receipt.subjectIdentityId === voter.identityId)) return "You can't rate your own take.";
  return null;
}

export async function refreshHeat(db: WriteDb, receipt: ReceiptRow, now: number): Promise<number | null> {
  const votes = await db.heatVotes.withIndex("by_receipt", (q) => q.eq("receiptId", receipt.id)).take(MAX_VOTES);
  // Linking accounts must not change the heat used to score a closed take.
  const open = receipt.status === "pending" && (receipt.dueAt === undefined || now < receipt.dueAt);
  const heat = open ? medianHeat(votes.map((vote) => vote.flames)) : receipt.heat ?? null;
  await db.receipts.update(receipt.id, { heat, voteCount: votes.length });
  return heat;
}

export async function recordHeatVote(db: WriteDb, receipt: ReceiptRow, voter: Voter, flames: number, now: number): Promise<number | null> {
  if (!isFlameRating(flames)) throw new Error("Heat must be 1 to 5 flames.");
  const blocked = voteBlockReason(receipt, receipt.subjectName, voter, now);
  if (blocked) throw new Error(blocked);
  if (!voter.userId && !voter.identityId) throw new Error("A voter identity is required.");
  const existing = voter.userId
    ? await db.heatVotes.withIndex("by_receipt_user", (q) => q.eq("receiptId", receipt.id).eq("userId", voter.userId)).first()
    : await db.heatVotes.withIndex("by_receipt_identity", (q) => q.eq("receiptId", receipt.id).eq("identityId", voter.identityId)).first();
  if (existing) {
    await db.heatVotes.update(existing.id, { flames, votedAt: now });
  } else {
    await db.heatVotes.insert({ receiptId: receipt.id, flames, votedAt: now,
      ...(voter.userId ? { userId: voter.userId } : { identityId: voter.identityId }) });
  }
  return refreshHeat(db, receipt, now);
}

/** Keep the most recent vote when a chat voter links an existing web account. */
export async function linkHeatVotes(db: WriteDb, identityId: string, userId: string, now: number): Promise<void> {
  // Linking can also reveal that an earlier web vote was on this person's own take.
  const own = await db.receipts.withIndex("by_subject_identity", (q) => q.eq("subjectIdentityId", identityId)).take(500);
  for (const receipt of own) {
    const vote = await db.heatVotes.withIndex("by_receipt_user", (q) => q.eq("receiptId", receipt.id).eq("userId", userId)).first();
    if (vote) {
      await db.heatVotes.delete(vote.id);
      await refreshHeat(db, receipt, now);
    }
  }
  const votes = await db.heatVotes.withIndex("by_identity", (q) => q.eq("identityId", identityId)).take(500);
  for (const vote of votes) {
    const receipt = await db.receipts.get(vote.receiptId);
    if (!receipt) continue;
    const existing = await db.heatVotes.withIndex("by_receipt_user", (q) => q.eq("receiptId", receipt.id).eq("userId", userId)).first();
    if (receipt.subjectUserId === userId) {
      await db.heatVotes.delete(vote.id);
      if (existing && existing.id !== vote.id) await db.heatVotes.delete(existing.id);
    } else if (existing && existing.id !== vote.id) {
      if ((vote.votedAt ?? 0) > (existing.votedAt ?? 0)) {
        await db.heatVotes.update(existing.id, { flames: vote.flames, votedAt: vote.votedAt });
      }
      await db.heatVotes.delete(vote.id);
    } else {
      await db.heatVotes.update(vote.id, { userId });
    }
    await refreshHeat(db, receipt, now);
  }
}
