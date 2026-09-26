// Resolves the message an "@receipts" command replied to (native iMessage Reply).
// Only that one message is looked up and forwarded; the rest of the chat stays on the Mac.
// Lakebed does not care where this comes from, so a chat.db-backed resolver could replace this one.

import { MAX_MESSAGE_TEXT_LENGTH, type ReplySource } from "../../app/shared/bot-api";
import type { BBMessage, BlueBubblesPort } from "./bluebubbles";
import { mentionsReceipts } from "./filter";

const THREAD_SCAN_LIMIT = 25;

export interface ReplySourceResolver {
  /**
   * The replied-to message, or null when the command is not a reply or the source cannot be captured
   * (missing, sent by the bot itself, or not text). Throws on transient lookup failures so the caller retries.
   */
  resolve(message: BBMessage): Promise<ReplySource | null>;
}

/**
 * Uses BlueBubbles' `threadOriginatorGuid`. iMessage records only the first message of a reply thread there,
 * so when the thread already had other replies (besides "@receipts" commands) before this command, the source is
 * marked `ambiguous` and Lakebed asks for the take to be spelled out. Thread messages are read locally to decide
 * this and are never forwarded.
 */
export class BlueBubblesReplyResolver implements ReplySourceResolver {
  constructor(private readonly bluebubbles: BlueBubblesPort) {}

  async resolve(message: BBMessage): Promise<ReplySource | null> {
    if (!message.threadOriginatorGuid) {
      return null;
    }
    const originator = message.threadOriginatorGuid;
    const source = await this.bluebubbles.getMessage(originator);
    const text = source?.text?.trim();
    const authorHandle = source?.handle?.address;
    // The bot's own messages (replying to a nomination with "accept 43") are not capturable sources.
    if (!source || source.isFromMe || !authorHandle || !text) {
      return null;
    }
    return {
      messageGuid: source.guid,
      text: text.slice(0, MAX_MESSAGE_TEXT_LENGTH),
      authorHandle,
      sentAt: source.dateCreated,
      ambiguous: await this.threadHadOtherReplies(message, originator)
    };
  }

  /** Whether anything besides "@receipts" commands was replied into this thread before the command. */
  private async threadHadOtherReplies(command: BBMessage, originator: string): Promise<boolean> {
    const chatGuid = command.chats?.[0]?.guid;
    if (!chatGuid) {
      return true;
    }
    const replies = await this.bluebubbles.threadReplies(chatGuid, originator, command.dateCreated, THREAD_SCAN_LIMIT);
    return replies.some(
      (reply) =>
        reply.guid !== command.guid &&
        reply.guid !== originator &&
        reply.dateCreated <= command.dateCreated &&
        !reply.isFromMe &&
        !reply.associatedMessageGuid &&
        !reply.associatedMessageType &&
        !mentionsReceipts(reply.text)
    );
  }
}
