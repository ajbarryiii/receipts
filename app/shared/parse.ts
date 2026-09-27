// Parses "@receipts ..." or leading "Receipts ..." messages into commands or receipt drafts.

import { findDeadline } from "./dates";
import type { IsoDate, ReceiptType, SettlementOutcome } from "./types";

export const MAX_STATEMENT_LENGTH = 280;
export const MAX_ALIAS_LENGTH = 30;

export type ReceiptSubject = { kind: "sender" } | { kind: "named"; name: string };

export type ReceiptDraft = {
  type: ReceiptType;
  /** True when the sender tagged the type (#take, #bet, ...), false when inferred. */
  typeExplicit: boolean;
  subject: ReceiptSubject;
  /** Canonical assertion shown on receipts. Never empty. */
  statement: string;
  deadline: { date: IsoDate; ambiguous: boolean } | null;
};

export type BotCommand =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "upcoming" }
  | { kind: "list" }
  | { kind: "mine" }
  | { kind: "join" }
  | { kind: "setup" }
  /** "@receipts lfg": starts the group's one-time Take Blitz. */
  | { kind: "lfg" }
  /** "@receipts exposed", replying to someone else's old take: puts it on the record as theirs. */
  | { kind: "exposed" }
  /** "@receipts told you so", replying to your own old take: puts it on the record to claim you called it. */
  | { kind: "toldYouSo" }
  | { kind: "show"; number: number }
  | { kind: "cancel"; number: number }
  | { kind: "rate"; number: number; flames: number }
  | { kind: "settle"; number: number; outcome: SettlementOutcome }
  | { kind: "accept"; number: number }
  | { kind: "reject"; number: number }
  | { kind: "nominations" }
  /** "@receipts call me Ace": sets how the bot names the sender. */
  | { kind: "rename"; name: string }
  | { kind: "create"; draft: ReceiptDraft }
  /**
   * A native reply whose statement is the replied-to message. Only produced when `isReply` is set.
   * `type` is null when untagged (infer it from the source text); `deadline` is null when the command had none.
   */
  | { kind: "capture"; type: ReceiptType | null; deadline: { date: IsoDate; ambiguous: boolean } | null }
  | { kind: "invalid"; reason: string };

export type ParseOptions = {
  /** The message is a native iMessage reply to a text message the bridge resolved. */
  isReply?: boolean;
};

// Plain contact names only address the bot at the start; do not strip them from receipt text.
const PREFIX = /^(\s*)receipts(?=$|[\s:,!?])/i;
const MENTION = /(^|[^\w@.])@receipts\b(?![\w-])/i;
const MENTION_GLOBAL = /(^|[^\w@.])@receipts\b(?![\w-])/gi;

const SIMPLE_COMMANDS: Record<string, BotCommand> = {
  "": { kind: "help" },
  help: { kind: "help" },
  commands: { kind: "help" },
  upcoming: { kind: "upcoming" },
  due: { kind: "upcoming" },
  soon: { kind: "upcoming" },
  list: { kind: "list" },
  pending: { kind: "list" },
  mine: { kind: "mine" },
  join: { kind: "join" },
  link: { kind: "join" },
  claim: { kind: "join" },
  setup: { kind: "setup" },
  "set up": { kind: "setup" },
  invite: { kind: "setup" },
  lfg: { kind: "lfg" },
  exposed: { kind: "exposed" },
  expose: { kind: "exposed" },
  "told you so": { kind: "toldYouSo" },
  "i told you so": { kind: "toldYouSo" },
  "told ya": { kind: "toldYouSo" },
  "told you": { kind: "toldYouSo" },
  "called it": { kind: "toldYouSo" },
  "i called it": { kind: "toldYouSo" },
  nominations: { kind: "nominations" }
};

/** Includes the type-specific words the bot uses (kept/broken, won/lost, fulfilled/not fulfilled). */
const SETTLE_WORDS: Record<string, SettlementOutcome> = {
  right: "right",
  correct: "right",
  kept: "right",
  won: "right",
  fulfilled: "right",
  wrong: "wrong",
  incorrect: "wrong",
  broken: "wrong",
  lost: "wrong",
  "not fulfilled": "wrong",
  void: "void"
};

const TYPE_TAGS: Record<string, ReceiptType> = {
  take: "take",
  prediction: "take",
  predict: "take",
  conditional: "conditional",
  cond: "conditional",
  if: "conditional",
  promise: "promise",
  bet: "bet",
  wager: "bet",
  generic: "generic",
  receipt: "generic",
  note: "generic"
};

const NAME_WORD = String.raw`[\p{L}][\p{L}\p{M}'’.-]*`;
const ATTRIBUTION_VERBS =
  "says|said|thinks|thought|predicts|predicted|claims|claimed|swears|swore|vows|vowed|guarantees|guaranteed|promises|promised|bets|believes|reckons|insists|insisted";
const FIRST_PERSON_VERBS =
  "say|said|think|thought|predict|predicted|claim|claimed|swear|swore|vow|vowed|guarantee|guaranteed|promise|promised|bet|believe|reckon|insist";

const FIRST_PERSON = new RegExp(String.raw`^(?:i|me)\s+(?<verb>${FIRST_PERSON_VERBS})\b(?:\s+that)?[:,]?\s*(?<rest>.*)$`, "iu");
const ME_COLON = /^me\s*[:\-–—]\s*(?<rest>.*)$/iu;
const NAMED_VERB = new RegExp(
  String.raw`^(?<name>${NAME_WORD}(?:\s+${NAME_WORD})?)\s+(?<verb>${ATTRIBUTION_VERBS})\b(?:\s+that)?[:,]?\s*(?<rest>.*)$`,
  "iu"
);
const NAME_COLON = new RegExp(String.raw`^(?<name>${NAME_WORD}(?:\s+${NAME_WORD})?)\s*:\s*(?<rest>.+)$`, "u");
const NAME_WILL = new RegExp(
  String.raw`^(?<name>\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*)?)\s+(?:will|won't|wont|is going to|is gonna|has to|owes|must|can't|cannot|never)\b`,
  "u"
);

/** Words that look like names in these patterns but are not people. */
const NOT_NAMES = new Set([
  "i",
  "me",
  "he",
  "she",
  "they",
  "it",
  "we",
  "you",
  "the",
  "a",
  "an",
  "this",
  "that",
  "who",
  "if",
  "when",
  "someone",
  "somebody",
  "everyone",
  "everybody",
  "nobody",
  "hot take",
  "take",
  "prediction",
  "note",
  "reminder",
  "bet",
  "promise",
  "update"
]);

const PROMISE_VERBS = new Set(["promise", "promises", "promised", "swear", "swears", "swore", "vow", "vows", "vowed"]);
const TAKE_VERBS = new Set(["predict", "predicts", "predicted", "guarantee", "guarantees", "guaranteed", "reckon", "reckons"]);
const FUTURE_TENSE = /\b(will|won't|wont|gonna|going to|never|by the time)\b/i;

/** True for an @receipts mention or a leading Receipts contact name. */
export function mentionsBot(text: string): boolean {
  return PREFIX.test(text) || MENTION.test(text);
}

/**
 * Interprets one chat message. `today` is the sender's local date, used for relative deadlines.
 * Returns `none` when the bot is not mentioned.
 * For replies, commands still win; otherwise a bare mention, tags, and a deadline capture the replied-to message,
 * and a full manual receipt ("Dana says ...") is still treated as manual.
 */
export function parseBotMessage(text: string, today: IsoDate, options: ParseOptions = {}): BotCommand {
  const mention = PREFIX.exec(text) ?? MENTION.exec(text);
  if (!mention) {
    return { kind: "none" };
  }
  const mentionEnd = mention.index + mention[0].length;
  const after = stripMentions(text.slice(mentionEnd));
  const body = cleanBody(after || stripMentions(text.slice(0, mention.index + mention[1].length)));

  if (options.isReply && !hasWords(body)) {
    return { kind: "capture", type: null, deadline: null };
  }
  const command = parseCommand(body);
  if (command) {
    return command;
  }
  return options.isReply ? parseCapture(body, today) : parseReceipt(body, today);
}

/** Normalized key for a typed name: "DJ" and "dj" and "D.J." map to the same key. */
export function nameKey(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMentions(value: string): string {
  return value.replace(MENTION_GLOBAL, "$1").trim();
}

function cleanBody(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[\s:,\-–—]+/, "").trim();
}

function hasWords(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function parseCommand(body: string): BotCommand | null {
  const trimmed = body.replace(/[?!.]+$/, "").trim();
  const lower = trimmed.toLowerCase();
  const simple = Object.hasOwn(SIMPLE_COMMANDS, lower) ? SIMPLE_COMMANDS[lower] : undefined;
  if (simple) {
    return simple;
  }
  const rating = /^#?(\d{1,6})\s*(🔥.*)$/u.exec(trimmed);
  if (rating || /^🔥/u.test(trimmed)) {
    const fires = rating?.[2].replace(/[\s\uFE0F]/gu, "") ?? "";
    if (!rating || !/^(?:🔥){1,5}$/u.test(fires)) {
      return { kind: "invalid", reason: "Rate a take with its number and 1–5 flames, like Receipts 43 🔥🔥." };
    }
    return { kind: "rate", number: Number(rating[1]), flames: [...fires].length };
  }
  const numbered = /^(cancel|accept|reject|decline)(?:\s+#?(\d{1,6}))?$/.exec(lower);
  if (numbered) {
    const verb = numbered[1] === "decline" ? "reject" : numbered[1];
    if (!numbered[2]) {
      return { kind: "invalid", reason: `Which one? Reply "@receipts ${verb} 43" with the receipt number.` };
    }
    const number = Number(numbered[2]);
    return verb === "cancel" ? { kind: "cancel", number } : verb === "accept" ? { kind: "accept", number } : { kind: "reject", number };
  }
  const callMe = /^call me\b\s*(.*)$/i.exec(trimmed);
  if (callMe) {
    const name = callMe[1].replace(/^["'“‘]+|["'”’]+$/gu, "").replace(/\s+/g, " ").trim();
    if (!hasWords(name) || name.length > MAX_ALIAS_LENGTH) {
      return { kind: "invalid", reason: `Pick a name up to ${MAX_ALIAS_LENGTH} characters, like: @receipts call me Ace` };
    }
    if (name.includes("👑")) {
      return { kind: "invalid", reason: "Nice try. The 👑 has to be won." };
    }
    return { kind: "rename", name };
  }
  const show = /^#?(\d{1,6})$/.exec(lower);
  if (show) {
    return { kind: "show", number: Number(show[1]) };
  }
  const settle = /^#?(\d{1,6})\s+([a-z]+(?: [a-z]+)?)$/.exec(lower);
  if (settle && Object.hasOwn(SETTLE_WORDS, settle[2])) {
    return { kind: "settle", number: Number(settle[1]), outcome: SETTLE_WORDS[settle[2]] };
  }
  return null;
}

/** Removes type tags (#take, #bet, ...), returning the first one and the remaining text. */
function extractTags(body: string): { type: ReceiptType | null; rest: string } {
  let type: ReceiptType | null = null;
  const rest = body
    .replace(/(^|\s)#([a-z]+)\b/gi, (whole, lead: string, tag: string) => {
      const key = tag.toLowerCase();
      const tagged = Object.hasOwn(TYPE_TAGS, key) ? TYPE_TAGS[key] : undefined;
      if (!tagged) return whole;
      type ??= tagged;
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { type, rest };
}

/** A reply whose text should only hold tags and a deadline; the replied-to message is the statement. */
function parseCapture(body: string, today: IsoDate): BotCommand {
  const { type, rest } = extractTags(body);
  if (!hasWords(rest)) {
    return { kind: "capture", type, deadline: null };
  }
  for (const candidate of [rest, `by ${rest}`]) {
    const match = findDeadline(candidate, today);
    if (match && !hasWords(candidate.slice(0, match.start) + candidate.slice(match.end))) {
      return { kind: "capture", type, deadline: { date: match.date, ambiguous: match.ambiguous } };
    }
  }
  if (matchAttribution(rest)) {
    return parseReceipt(body, today);
  }
  if (DEADLINE_LEAD.test(rest)) {
    return { kind: "invalid", reason: `I couldn't read "${rest}" as a date. Try: @receipts #take by Apr 15 2027` };
  }
  return { kind: "invalid", reason: `Whose take is that? Spell it out: @receipts #${type ?? "take"} <name>: ${rest}` };
}

/** Text that starts like a deadline ("by the All-Star break") rather than a statement. */
const DEADLINE_LEAD = /^(by|before|on|until|till|til|in|within|due|come|end of|eo[wmy])\b/i;

function parseReceipt(body: string, today: IsoDate): BotCommand {
  const { type: explicitType, rest: untagged } = extractTags(body);

  let subject: ReceiptSubject = { kind: "sender" };
  let statement = untagged;
  let verb: string | null = null;

  const attributed = matchAttribution(untagged);
  if (attributed) {
    subject = attributed.subject;
    statement = attributed.rest;
    verb = attributed.verb;
    if (!statement.trim()) {
      return { kind: "invalid", reason: "Tell me what to lock in, like: @receipts #take Dana says the Giants win by Oct 1 2027" };
    }
  }

  const deadlineMatch = findDeadline(statement, today);
  const type = explicitType ?? inferType(statement, verb, deadlineMatch !== null);

  if (!attributed && (type === "conditional" || type === "promise")) {
    const will = NAME_WILL.exec(untagged);
    const name = will?.groups?.name;
    if (name && !NOT_NAMES.has(name.toLowerCase())) {
      subject = { kind: "named", name };
    }
  }

  if (deadlineMatch && (type === "take" || type === "generic") && /^[\s.,;:!"'”’)]*$/.test(statement.slice(deadlineMatch.end))) {
    statement = statement.slice(0, deadlineMatch.start);
  }

  const finalStatement = finishStatement(statement);
  if (!finalStatement) {
    return { kind: "invalid", reason: "Tell me what to lock in, like: @receipts #take Dana says the Giants win by Oct 1 2027" };
  }

  return {
    kind: "create",
    draft: {
      type,
      typeExplicit: explicitType !== null,
      subject,
      statement: finalStatement,
      deadline: deadlineMatch ? { date: deadlineMatch.date, ambiguous: deadlineMatch.ambiguous } : null
    }
  };
}

function matchAttribution(text: string): { subject: ReceiptSubject; rest: string; verb: string | null } | null {
  const firstPerson = FIRST_PERSON.exec(text);
  if (firstPerson?.groups) {
    return { subject: { kind: "sender" }, rest: firstPerson.groups.rest, verb: firstPerson.groups.verb.toLowerCase() };
  }
  const meColon = ME_COLON.exec(text);
  if (meColon?.groups) {
    return { subject: { kind: "sender" }, rest: meColon.groups.rest, verb: null };
  }
  const named = NAMED_VERB.exec(text);
  if (named?.groups && !NOT_NAMES.has(named.groups.name.toLowerCase())) {
    return { subject: { kind: "named", name: named.groups.name }, rest: named.groups.rest, verb: named.groups.verb.toLowerCase() };
  }
  const colon = NAME_COLON.exec(text);
  if (colon?.groups && !NOT_NAMES.has(colon.groups.name.toLowerCase())) {
    return { subject: { kind: "named", name: colon.groups.name }, rest: colon.groups.rest, verb: null };
  }
  return null;
}

/** Receipt type implied by a statement, used when nobody tagged one. */
export function inferReceiptType(statement: string, hasDeadline: boolean): ReceiptType {
  const attributed = matchAttribution(statement);
  return inferType(attributed?.rest ?? statement, attributed?.verb ?? null, hasDeadline);
}

function inferType(statement: string, verb: string | null, hasDeadline: boolean): ReceiptType {
  if (verb === "bet" || verb === "bets" || (/\b(loser|winner)s?\b/i.test(statement) && /\b(buys?|pays?|owes?|gets?|covers?)\b/i.test(statement))) {
    return "bet";
  }
  if (verb && PROMISE_VERBS.has(verb)) {
    return "promise";
  }
  if (/\bif\b/i.test(statement)) {
    return "conditional";
  }
  if (hasDeadline || FUTURE_TENSE.test(statement) || (verb !== null && TAKE_VERBS.has(verb))) {
    return "take";
  }
  return "generic";
}

function finishStatement(value: string): string {
  let statement = value
    .replace(/^[\s"'“”‘’]+/u, "")
    .replace(/[\s.,;:"'“”‘’]+$/u, "");
  if (!statement) {
    return "";
  }
  const firstWord = statement.split(" ", 1)[0];
  if (/^[a-z][a-z'’-]*$/.test(firstWord)) {
    statement = statement[0].toUpperCase() + statement.slice(1);
  }
  if (statement.length > MAX_STATEMENT_LENGTH) {
    statement = `${statement.slice(0, MAX_STATEMENT_LENGTH - 1)}…`;
  }
  return statement;
}
