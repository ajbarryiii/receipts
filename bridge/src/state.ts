// The bridge's only local state: a catch-up cursor, recently handled message GUIDs,
// and acknowledgements owed to Lakebed for replies, reminders, and announcements already handed to iMessage.
// Lakebed stays the source of truth; losing this file costs at most some duplicate submissions.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PendingAck =
  | { kind: "reply"; messageGuid: string }
  | { kind: "reminder"; receiptId: string }
  | { kind: "announcement"; announcementId: string };

export type BridgeState = {
  version: 1;
  /** Highest chat.db ROWID the catch-up scan has fully handled. */
  cursorRowId: number | null;
  /** Recently handled message GUIDs, oldest first, so scans skip them without calling Lakebed. */
  recentGuids: string[];
  /** Sent to iMessage but not yet acknowledged to Lakebed. Never resend these. */
  pendingAcks: PendingAck[];
};

export const MAX_RECENT_GUIDS = 2000;

export function emptyState(): BridgeState {
  return { version: 1, cursorRowId: null, recentGuids: [], pendingAcks: [] };
}

export interface StateStore {
  load(): Promise<BridgeState>;
  save(state: BridgeState): Promise<void>;
}

/** JSON file store with atomic replace. A missing file loads as empty state; a corrupt one is set aside. */
export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<BridgeState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
    try {
      return normalize(JSON.parse(text));
    } catch {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
      return emptyState();
    }
  }

  async save(state: BridgeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export class MemoryStateStore implements StateStore {
  saved: BridgeState | null = null;

  constructor(private initial: BridgeState = emptyState()) {}

  async load(): Promise<BridgeState> {
    return structuredClone(this.saved ?? this.initial);
  }

  async save(state: BridgeState): Promise<void> {
    this.saved = structuredClone(state);
  }
}

function normalize(value: unknown): BridgeState {
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) {
    throw new Error("Unsupported state file.");
  }
  const raw = value as Partial<BridgeState>;
  return {
    version: 1,
    cursorRowId: typeof raw.cursorRowId === "number" && Number.isFinite(raw.cursorRowId) ? raw.cursorRowId : null,
    recentGuids: Array.isArray(raw.recentGuids) ? raw.recentGuids.filter((guid) => typeof guid === "string") : [],
    pendingAcks: Array.isArray(raw.pendingAcks)
      ? raw.pendingAcks.filter(
          (ack): ack is PendingAck =>
            (ack?.kind === "reply" && typeof ack.messageGuid === "string") ||
            (ack?.kind === "reminder" && typeof ack.receiptId === "string") ||
            (ack?.kind === "announcement" && typeof ack.announcementId === "string")
        )
      : []
  };
}
