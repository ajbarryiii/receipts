// Domain vocabulary and the view shapes the web client receives.
// Pure TypeScript: shared by server, client, and tests.

export const RECEIPT_TYPES = ["take", "conditional", "promise", "bet", "generic"] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export const SETTLEMENT_OUTCOMES = ["right", "wrong", "void"] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

/**
 * Lifecycle of a receipt:
 * - `nominated`: someone replied "@receipts" to another person's message; waiting for that author to accept.
 * - `pending`: official and unsettled. Only official receipts are rated, reminded, and scored.
 * - `right` | `wrong` | `void`: settled.
 * - `rejected`: the author declined the nomination. Never scored.
 * - `canceled`: retracted by whoever logged it shortly after; kept only for idempotency.
 */
export type ReceiptStatus = "nominated" | "pending" | SettlementOutcome | "rejected" | "canceled";

/** Statuses that belong to the official record (rated, reminded, scored). */
export const OFFICIAL_STATUSES: readonly ReceiptStatus[] = ["pending", "right", "wrong", "void"];

/**
 * `reply`: an Original Receipt, captured from the exact iMessage its author sent.
 * `manual`: a Recorded Claim, typed into chat by someone.
 */
export type CaptureMode = "manual" | "reply";

export type NominationState = "pending" | "accepted" | "rejected";

/**
 * How someone called out an old message, putting it on the record as a take by its author with no deadline:
 * - `exposed`: "@receipts exposed" as a reply to someone else's message.
 * - `told_you_so`: "@receipts told you so" as a reply to your own message.
 */
export const CALLOUTS = ["exposed", "told_you_so"] as const;
export type Callout = (typeof CALLOUTS)[number];

export type MemberRole = "owner" | "member";

export type InviteKind = "join" | "invite";

/** Calendar date without a time zone, e.g. "2027-10-01". */
export type IsoDate = string;

/**
 * Stable key for "who a receipt is about" within a group:
 * - `u:<userId>` a linked web account
 * - `i:<identityId>` an iMessage sender who has not linked an account yet
 * - `n:<nameKey>` a name typed in chat (e.g. "Dana") that nobody has claimed yet
 */
export type SubjectRef = string;

export function isReceiptType(value: unknown): value is ReceiptType {
  return typeof value === "string" && (RECEIPT_TYPES as readonly string[]).includes(value);
}

export function isSettlementOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === "string" && (SETTLEMENT_OUTCOMES as readonly string[]).includes(value);
}

export function isCallout(value: unknown): value is Callout {
  return typeof value === "string" && (CALLOUTS as readonly string[]).includes(value);
}

export type NominationView = {
  state: NominationState;
  nominatedByName: string;
  nominatedAt: number;
};

export type CalloutView = {
  kind: Callout;
  /** Whoever sent the command: the exposer, or the author claiming they called it. */
  byName: string;
};

export type ReceiptCard = {
  id: string;
  groupId: string;
  number: number;
  type: ReceiptType;
  status: ReceiptStatus;
  capture: CaptureMode;
  subjectRef: SubjectRef;
  subjectName: string;
  /** For `reply` captures, the exact text of the original iMessage. */
  statement: string;
  /** Local calendar date the claim was made (for `reply` captures, when the original iMessage was sent). */
  madeOn: IsoDate;
  deadline: IsoDate | null;
  dueAt: number | null;
  /** Official heat: median of votes while pending, frozen at settlement. */
  heat: number | null;
  voteCount: number;
  settledAt: number | null;
  /** Null for receipts nobody nominated (manual entries and self-captures). */
  nomination: NominationView | null;
  /** Set for old takes put on the record with "exposed" or "told you so". */
  callout: CalloutView | null;
};

export type Standing = {
  subjectRef: SubjectRef;
  name: string;
  takeScore: number;
  right: number;
  wrong: number;
  pending: number;
  /** right / (right + wrong), or null with no decided takes. */
  accuracy: number | null;
  /** Mean official heat across the subject's rated takes. */
  averageHeat: number | null;
};

/**
 * Take Blitz phases after "@receipts lfg":
 * - `live`: the 24-hour window when takes earn blitz points.
 * - `provisional`: the window closed; the crown goes to the leader for now and can change hands as takes settle.
 * - `final`: the crown is anointed; unsettled blitz takes kept half their points and the result never changes.
 */
export type BlitzPhase = "live" | "provisional" | "final";

/** One person's blitz score. `total` is `banked` plus `tab`. */
export type BlitzStanding = {
  subjectRef: SubjectRef;
  name: string;
  /** Blitz takes that earned points (at most BLITZ_TAKE_CAP). */
  takes: number;
  /** Points locked in by settled takes (and, once final, by unsettled takes at half). */
  banked: number;
  /** Points riding on unsettled takes at full value. Always 0 once final. */
  tab: number;
  total: number;
};

export type BlitzView = {
  phase: BlitzPhase;
  startedAt: number;
  endsAt: number;
  anointAt: number;
  /** Highest total first. */
  board: BlitzStanding[];
  /** Who wears the 👑: empty while live, the leaders (ties share it) afterwards. */
  crown: SubjectRef[];
};

export type GroupSummary = {
  id: string;
  name: string;
  role: MemberRole;
};

export type MemberView = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: MemberRole;
  isMe: boolean;
};

export type HomeView = {
  displayName: string;
  groups: GroupSummary[];
};

export type GroupView = {
  id: string;
  name: string;
  role: MemberRole;
  members: MemberView[];
  /** Nominations waiting on their author, newest first. Not part of the official record yet. */
  nominations: ReceiptCard[];
  /** Official pending receipts that are overdue or due within 30 days, soonest first. */
  dueSoon: ReceiptCard[];
  /** All official pending receipts, newest first. */
  pending: ReceiptCard[];
  /** Up to 10 settled receipts, most recently settled first. */
  recentlySettled: ReceiptCard[];
  standings: Standing[];
  /** The group's Take Blitz, once someone has sent "@receipts lfg". */
  blitz: BlitzView | null;
};

export type HeatVoteView = {
  name: string;
  flames: number;
  isMine: boolean;
};

export type SettlementView = {
  outcome: SettlementOutcome;
  settledByName: string;
  notes: string | null;
  at: number;
};

export type ReceiptDetail = {
  card: ReceiptCard;
  groupName: string;
  originalText: string;
  createdByName: string;
  dateAmbiguous: boolean;
  votes: HeatVoteView[];
  myVote: number | null;
  /** Null when the viewer may vote; otherwise the reason they cannot. */
  voteBlockedReason: string | null;
  canSettle: boolean;
  /** Why the viewer cannot settle (or correct) this receipt; null when they can or when settling does not apply. */
  settleBlockedReason: string | null;
  canEditDeadline: boolean;
  /** True when the viewer is the author of a nominated receipt and may accept or reject it. */
  canRespond: boolean;
  settlements: SettlementView[];
  /** Take Score points awarded, for settled takes. */
  points: number | null;
};

export type ProfileView = {
  groupId: string;
  groupName: string;
  subjectRef: SubjectRef;
  name: string;
  isMe: boolean;
  /** True when this is an unclaimed chat name the viewer can claim as themselves. */
  claimable: boolean;
  /** Wears the Take Blitz 👑. */
  crowned: boolean;
  standing: Standing;
  hottestCorrect: ReceiptCard | null;
  /** Nominations of this subject's messages that are waiting on them. */
  nominations: ReceiptCard[];
  currentTakes: ReceiptCard[];
  recent: ReceiptCard[];
  promises: ReceiptCard[];
  bets: ReceiptCard[];
  conditionals: ReceiptCard[];
};

export type InviteView = {
  kind: InviteKind;
  groupId: string;
  groupName: string;
  /** Masked sender handle for identity links, e.g. "•••0123". Never the raw handle. */
  handleHint: string | null;
  status: "valid" | "expired" | "used";
  alreadyMember: boolean;
};
