// Decides which iMessages leave the Mac. Only messages addressing Receipts from other people do.

import { MAX_MESSAGE_TEXT_LENGTH, type IncomingMessage } from "../../app/shared/bot-api";
import type { BBChat, BBMessage } from "./bluebubbles";

export type FilterOptions = {
  /** Forward one-to-one chats too. Off by default: Receipts lives in group chats. */
  allowDirectChats: boolean;
  /** Host UTC offset in minutes at an instant (e.g. -420 for PDT). */
  utcOffsetMinutes: (at: number) => number;
};

// Same rule as app/shared/parse.ts mentionsBot; duplicated so the bridge bundle stays tiny.
const PREFIX = /^(\s*)receipts(?=$|[\s:,!?])/i;
const MENTION = /(^|[^\w@.])@receipts\b(?![\w-])/i;

export function mentionsReceipts(text: string | null | undefined): boolean {
  return PREFIX.test(text ?? "") || MENTION.test(text ?? "");
}

export function isGroupChat(chat: BBChat): boolean {
  return chat.guid.includes(";+;") || chat.style === 43;
}

/**
 * Converts a BlueBubbles message into the Lakebed payload, or null when it must not be forwarded:
 * the bot's own messages, tapbacks, messages not addressing Receipts, or direct chats (unless allowed).
 */
export function toIncomingMessage(message: BBMessage, options: FilterOptions): IncomingMessage | null {
  if (message.isFromMe || message.associatedMessageGuid || message.associatedMessageType) {
    return null;
  }
  if ((message.itemType ?? 0) !== 0) {
    return null;
  }
  const text = message.text ?? "";
  if (!mentionsReceipts(text)) {
    return null;
  }
  const chat = message.chats?.[0];
  const sender = message.handle?.address;
  if (!chat?.guid || !sender) {
    return null;
  }
  if (!options.allowDirectChats && !isGroupChat(chat)) {
    return null;
  }
  return {
    messageGuid: message.guid,
    chatGuid: chat.guid,
    chatName: chat.displayName?.trim() || null,
    senderHandle: sender,
    text: text.slice(0, MAX_MESSAGE_TEXT_LENGTH),
    sentAt: message.dateCreated,
    utcOffsetMinutes: options.utcOffsetMinutes(message.dateCreated),
    // Filled in by the bridge after it resolves the replied-to message locally.
    replyTo: null
  };
}
