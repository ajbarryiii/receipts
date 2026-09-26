import type { AuthContext, LogContext, ReadDatabaseOf, WriteDatabaseOf } from "lakebed/server";
import type { schema } from "./schema";

type Definition = { schema: typeof schema };

export type ReadDb = ReadDatabaseOf<Definition>;
export type WriteDb = WriteDatabaseOf<Definition>;

type RowFor<TTable extends keyof WriteDb> = NonNullable<Awaited<ReturnType<WriteDb[TTable]["get"]>>>;

export type GroupRow = RowFor<"groups">;
export type MembershipRow = RowFor<"memberships">;
export type IdentityRow = RowFor<"identities">;
export type ReceiptRow = RowFor<"receipts">;
export type HeatVoteRow = RowFor<"heatVotes">;
export type SettlementRow = RowFor<"settlements">;
export type InviteRow = RowFor<"invites">;
export type ProfileRow = RowFor<"profiles">;

/** The slice of a handler context the web modules need. */
export type WebReadCtx = { auth: AuthContext; db: ReadDb };
export type WebWriteCtx = { auth: AuthContext; db: WriteDb };

/** The slice of an endpoint context the bot module needs. */
export type BotCtx = { db: WriteDb; log: LogContext };
export type BotReadCtx = { db: ReadDb; log: LogContext };
