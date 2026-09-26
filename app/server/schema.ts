import { boolean, id, number, string, table, userId } from "lakebed/server";

export const schema = {
  /** Web accounts (Google sign-in). */
  profiles: table({
    userId: userId(),
    displayName: string(),
    avatarUrl: string().optional()
  }).index("by_user", ["userId"]),

  /** One row per iMessage conversation the bot is in. */
  groups: table({
    name: string(),
    chatGuid: string(),
    /** Next per-group receipt number (#1, #2, ...). */
    nextNumber: number().default(1),
    /** Latest UTC offset reported by the bridge, used for local dates. */
    utcOffsetMinutes: number().default(0),
    /** When "@receipts lfg" started the group's one-time Take Blitz (epoch ms). */
    blitzStartedAt: number().optional()
  }).index("by_chat", ["chatGuid"]),

  memberships: table({
    groupId: id("groups"),
    userId: userId(),
    nickname: string().optional(),
    /** "owner" | "member" */
    role: string()
  })
    .index("by_group", ["groupId"])
    .index("by_user", ["userId"])
    .index("by_group_user", ["groupId", "userId"]),

  /** iMessage senders seen in a group. `handle` is private and never returned to clients. */
  identities: table({
    groupId: id("groups"),
    handle: string(),
    userId: userId().optional(),
    /** Set with "@receipts call me <name>"; how the bot names this sender. */
    displayAlias: string().optional()
  })
    .index("by_group_handle", ["groupId", "handle"])
    .index("by_group_user", ["groupId", "userId"]),

  /** Chat names ("Dana") claimed by a web account within a group. */
  nameClaims: table({
    groupId: id("groups"),
    nameKey: string(),
    userId: userId()
  })
    .index("by_group_name", ["groupId", "nameKey"])
    .index("by_group_user", ["groupId", "userId"]),

  receipts: table({
    groupId: id("groups"),
    number: number(),
    /** ReceiptType */
    type: string(),
    /** ReceiptStatus */
    status: string(),
    /** CaptureMode: "manual" (typed into chat) or "reply" (the exact iMessage its author sent). */
    capture: string().default("manual"),
    subjectName: string(),
    subjectKey: string(),
    subjectUserId: userId().optional(),
    subjectIdentityId: id("identities").optional(),
    /** Whoever sent the "@receipts" command. For nominations, the nominator. */
    createdByUserId: userId().optional(),
    createdByIdentityId: id("identities").optional(),
    /** For reply captures, the exact text of the replied-to iMessage. */
    statement: string(),
    /** The "@receipts" command text. */
    originalText: string(),
    /** GUID of the "@receipts" command message; unique per receipt. */
    commandMessageGuid: string(),
    /** For reply captures, the replied-to message. */
    sourceMessageGuid: string().optional(),
    sourceSentAt: number().optional(),
    madeOn: string(),
    deadline: string().optional(),
    dueAt: number().optional(),
    dateAmbiguous: boolean().default(false),
    heat: number().optional(),
    voteCount: number().default(0),
    /** When the message was sent (epoch ms). */
    madeAt: number(),
    /** When the bot processed it (epoch ms); starts the cancel window. */
    loggedAt: number(),
    settledAt: number().optional(),
    remindedAt: number().optional(),
    /** Set when someone other than the author captured it; the nominator is `createdBy*`. */
    nominatedAt: number().optional(),
    acceptedAt: number().optional(),
    rejectedAt: number().optional(),
    /** Callout: set for old takes put on the record with "exposed" or "told you so". */
    callout: string().optional(),
    /** Take Blitz points the take earned when it was logged. Unset for everything that isn't a point-earning blitz take. */
    blitzPoints: number().optional(),
    /** Blitz points the take keeps, fixed by its latest settlement before the crown was anointed. */
    blitzKept: number().optional()
  })
    .index("by_group_number", ["groupId", "number"])
    .index("by_command", ["commandMessageGuid"])
    .index("by_group_source", ["groupId", "sourceMessageGuid"])
    .index("by_due", ["status", "remindedAt", "dueAt"])
    .index("by_group_subject_key", ["groupId", "subjectKey"])
    .index("by_subject_identity", ["subjectIdentityId"])
    .index("by_creator_identity", ["createdByIdentityId"])
    .index("by_group_blitz", ["groupId", "blitzPoints"]),

  heatVotes: table({
    receiptId: id("receipts"),
    userId: userId(),
    flames: number()
  })
    .index("by_receipt", ["receiptId"])
    .index("by_receipt_user", ["receiptId", "userId"]),

  settlements: table({
    receiptId: id("receipts"),
    /** SettlementOutcome */
    outcome: string(),
    /** Set for web settlements, and for chat settlements once the sender links an account. */
    settledByUserId: userId().optional(),
    /** Set for chat settlements ("@receipts 43 right"). */
    settledByIdentityId: id("identities").optional(),
    notes: string().optional(),
    at: number()
  })
    .index("by_receipt", ["receiptId"])
    .index("by_settler_identity", ["settledByIdentityId"]),

  /** Idempotency ledger for incoming chat messages. `reply` is kept only until the bridge acknowledges it. */
  processedMessages: table({
    messageGuid: string(),
    groupId: id("groups").optional(),
    reply: string().optional(),
    repliedAt: number().optional()
  }).index("by_guid", ["messageGuid"]),

  /**
   * Messages the bot posts into a group on its own, delivered by the bridge like reminders.
   * "@receipts lfg" schedules the Take Blitz news (`blitz_over`, `last_call`, `anointed`), which is worded when it
   * goes out. `crown` announcements (the crown changing hands on a web settlement) are worded when they happen.
   */
  announcements: table({
    groupId: id("groups"),
    /** "blitz_over" | "last_call" | "anointed" | "crown" */
    kind: string(),
    /** Fixed text for `crown`; scheduled kinds render from the group's current state. */
    message: string().optional(),
    sendAt: number(),
    sentAt: number().optional()
  })
    .index("by_due", ["sentAt", "sendAt"])
    .index("by_group_due", ["groupId", "sentAt", "sendAt"]),

  /** Web links sent into chat: `join` links one sender identity, `invite` adds group members. */
  invites: table({
    token: string(),
    /** InviteKind */
    kind: string(),
    groupId: id("groups"),
    identityId: id("identities").optional(),
    expiresAt: number(),
    usedAt: number().optional()
  }).index("by_token", ["token"])
};
