// Bot message copy and small display helpers shared by the bot and the web app.

import { BLITZ_TAKE_CAP, CALLOUT_POINTS, LIGHTNING_POINTS, WEEK_POINTS } from "./blitz";
import { formatDate, formatDateTime } from "./dates";
import { gradeLabels, takeTemp, type TakeGrade } from "./jev";
import type { BlitzPhase, BlitzStanding, CaptureMode, IsoDate, ReceiptStatus, ReceiptType, SettlementOutcome, SubjectRef } from "./types";

/** Everything the bot needs to describe one receipt in chat. */
export type ChatReceipt = {
  number: number;
  type: ReceiptType;
  status: ReceiptStatus;
  /** `reply` statements are exact quotes and are never re-punctuated. */
  capture: CaptureMode;
  subjectName: string;
  statement: string;
  madeOn: IsoDate;
  deadline: IsoDate | null;
  dateAmbiguous: boolean;
  heat: number | null;
};

const TYPE_LABELS: Record<ReceiptType, string> = {
  take: "Take",
  conditional: "Conditional",
  promise: "Promise",
  bet: "Bet",
  generic: "Receipt"
};

const OUTCOME_LABELS: Record<ReceiptType, Record<SettlementOutcome, string>> = {
  take: { right: "Right", wrong: "Wrong", void: "Void" },
  generic: { right: "Right", wrong: "Wrong", void: "Void" },
  promise: { right: "Kept", wrong: "Broken", void: "Void" },
  bet: { right: "Won", wrong: "Lost", void: "Void" },
  conditional: { right: "Fulfilled", wrong: "Not fulfilled", void: "Void" }
};

/** The chat words that settle each type, in "@receipts 43 <word>" form. */
const SETTLE_HINTS: Record<ReceiptType, [string, string]> = {
  take: ["right", "wrong"],
  generic: ["right", "wrong"],
  promise: ["kept", "broken"],
  bet: ["won", "lost"],
  conditional: ["fulfilled", "not fulfilled"]
};

const OUTCOME_EMOJI: Record<SettlementOutcome, string> = { right: "✅", wrong: "❌", void: "➖" };

const REMINDER_VERBS: Record<ReceiptType, string> = {
  take: "said",
  conditional: "said",
  generic: "said",
  promise: "promised",
  bet: "bet"
};

/** Privacy-safe label for an iMessage handle: "•••0123" for phones, "j•••@icloud.com" for emails. */
export function maskHandle(handle: string): string {
  const trimmed = handle.trim();
  const at = trimmed.indexOf("@");
  if (at > 0) {
    return `${trimmed[0]}•••${trimmed.slice(at)}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : "•••";
}

/** "🔥🔥🔥" for heat 3, "unrated" without heat. */
export function flames(heat: number | null): string {
  return heat === null ? "unrated" : "🔥".repeat(heat);
}

/**
 * Wraps a statement in quotes, ending it with a period unless it already ends in punctuation.
 * `exact` quotes (captured iMessages) are wrapped as-is.
 */
export function quoteStatement(statement: string, exact = false): string {
  return exact || /[.!?…]$/.test(statement) ? `"${statement}"` : `"${statement}."`;
}

function quote(receipt: Pick<ChatReceipt, "statement" | "capture">): string {
  return quoteStatement(receipt.statement, receipt.capture === "reply");
}

function dueLine(receipt: Pick<ChatReceipt, "deadline" | "dateAmbiguous">, today: IsoDate): string {
  if (!receipt.deadline) {
    return "Due: no date. Settle it whenever.";
  }
  if (receipt.dateAmbiguous) {
    const past = receipt.deadline < today ? ", which already passed" : "";
    return `Due: ${formatDate(receipt.deadline)} (my best guess${past})`;
  }
  return `Due: ${formatDate(receipt.deadline)}`;
}

const LATE_LINE = "(Sorry for the delay, I was offline.)";

/** "Take", "Conditional", "Promise", "Bet", "Receipt". */
export function typeLabel(type: ReceiptType): string {
  return TYPE_LABELS[type];
}

/** Outcome wording per type, e.g. promises are "Kept"/"Broken" rather than "Right"/"Wrong". */
export function outcomeLabel(type: ReceiptType, outcome: SettlementOutcome): string {
  return OUTCOME_LABELS[type][outcome];
}

/** The chat words that settle a type as right and wrong, e.g. ["kept", "broken"] for promises. */
export function settleWords(type: ReceiptType): readonly [string, string] {
  return SETTLE_HINTS[type];
}

/** Reply after logging a receipt. `late` marks catch-up processing after the bridge was offline. */
export function confirmationMessage(receipt: ChatReceipt, options: { today: IsoDate; late: boolean }): string {
  const lines = [`🧾 ${typeLabel(receipt.type).toUpperCase()} LOCKED`, "", `${receipt.subjectName}:`, quote(receipt), "", dueLine(receipt, options.today)];
  if (receipt.type === "take") {
    lines.push(`Heat: ${flames(receipt.heat)}`);
  }
  lines.push("", `Receipt #${receipt.number}`);
  if (receipt.deadline && receipt.dateAmbiguous) {
    lines.push(`Reply "@receipts cancel ${receipt.number}" if I read the date wrong.`);
  }
  if (options.late) {
    lines.push(LATE_LINE);
  }
  return lines.join("\n");
}

/** Deadline resurfacing message sent into the original chat. */
export function reminderMessage(receipt: ChatReceipt, url: string): string {
  const lines = [
    "🚨 RECEIPT DUE",
    "",
    `On ${formatDate(receipt.madeOn)}, ${receipt.subjectName} ${REMINDER_VERBS[receipt.type]}:`,
    "",
    quote(receipt),
    ""
  ];
  if (receipt.type === "take") {
    lines.push(`Heat: ${flames(receipt.heat)}`);
    if (receipt.heat === 5) {
      lines.push("That one's going in the vault.");
    }
  }
  const [yes, no] = settleWords(receipt.type);
  lines.push("Time to settle it. 🧾", `Reply "@receipts ${receipt.number} ${yes}" or "@receipts ${receipt.number} ${no}".`, url);
  return lines.join("\n");
}

/** Reply to "@receipts 43". */
export function receiptDetailMessage(receipt: ChatReceipt, url: string): string {
  const dates = [`Made ${formatDate(receipt.madeOn)}`, receipt.deadline ? `Due ${formatDate(receipt.deadline)}` : "No due date"];
  const lines = [
    `🧾 RECEIPT #${receipt.number} · ${typeLabel(receipt.type).toUpperCase()}`,
    "",
    `${receipt.subjectName}:`,
    quote(receipt),
    "",
    dates.join(" · ")
  ];
  if (receipt.type === "take") {
    lines.push(`Heat: ${flames(receipt.heat)}`);
  }
  lines.push(`Status: ${statusLabel(receipt)}`, "", url);
  return lines.join("\n");
}

/** Reply to "list", "upcoming", and "mine". */
export function receiptListMessage(title: string, receipts: readonly ChatReceipt[], url: string, emptyText: string): string {
  if (receipts.length === 0) {
    return [`🧾 ${title}`, "", emptyText, "", url].join("\n");
  }
  const rows = receipts.map((receipt) => {
    const due = receipt.deadline ? ` · due ${formatDate(receipt.deadline)}` : "";
    return `#${receipt.number} ${receipt.subjectName}: ${quote(receipt)}${due}`;
  });
  return [`🧾 ${title}`, "", ...rows, "", url].join("\n");
}

export function helpMessage(appUrl: string): string {
  return [
    "🧾 RECEIPTS",
    "",
    "@receipts #take Dana says the Giants win by Oct 1 2027",
    "Also #promise, #bet, #conditional, or no tag at all.",
    "",
    "Reply to an old message: @receipts exposed / told you so",
    "",
    "@receipts upcoming · list · mine",
    "@receipts 43 · cancel 43",
    "@receipts 43 right / wrong / void (settle it)",
    "@receipts join (link your profile)",
    "@receipts setup (invite link for the record book)",
    "@receipts lfg (start the 24-hour take blitz)",
    "",
    appUrl
  ].join("\n");
}

export function joinMessage(url: string, expiresInMinutes: number): string {
  return ["🧾 Claim your Receipts profile:", "", url, "", `Link expires in ${expiresInMinutes} minutes.`].join("\n");
}

export function setupMessage(groupName: string, url: string, expiresInDays: number): string {
  return [
    `🧾 Receipts is live in "${groupName}".`,
    "",
    `Record book invite (expires in ${expiresInDays} days):`,
    url,
    "",
    'Link your own texts with "@receipts join".'
  ].join("\n");
}

export function canceledMessage(number: number): string {
  return `🗑️ Receipt #${number} canceled.`;
}

/** Human status for chat and web: "Pending", "Right", "Kept", "Awaiting Dana", "Declined", ... */
export function statusLabel(receipt: Pick<ChatReceipt, "type" | "status" | "subjectName">): string {
  switch (receipt.status) {
    case "nominated":
      return `Awaiting ${receipt.subjectName}`;
    case "pending":
      return "Pending";
    case "rejected":
      return "Declined";
    case "canceled":
      return "Canceled";
    default:
      return outcomeLabel(receipt.type, receipt.status);
  }
}

/** Reply when someone nominates another person's message. */
export function nominationMessage(receipt: ChatReceipt, options: { nominatorName: string; today: IsoDate; late: boolean }): string {
  const lines = [
    `🧾 ${typeLabel(receipt.type).toUpperCase()} NOMINATED`,
    "",
    `${receipt.subjectName}:`,
    quote(receipt),
    "",
    dueLine(receipt, options.today),
    `Nominated by ${options.nominatorName}`,
    "",
    `${receipt.subjectName}: reply "@receipts accept ${receipt.number}" to put it on the books.`
  ];
  if (options.late) {
    lines.push(LATE_LINE);
  }
  return lines.join("\n");
}

/** Reply when the author accepts a nomination. */
export function acceptedMessage(receipt: ChatReceipt, url: string): string {
  const lines = [
    "🔒 ON THE RECORD",
    "",
    `${receipt.subjectName}'s ${typeLabel(receipt.type).toLowerCase()} is official.`,
    "",
    quote(receipt),
    "",
    receipt.deadline ? `Due: ${formatDate(receipt.deadline)}` : "Due: no date."
  ];
  if (receipt.type === "take") {
    lines.push("Now rate the heat. 🔥");
  }
  lines.push(url);
  return lines.join("\n");
}

/** Reply when the author declines a nomination. Playful, never punitive. */
export function rejectedMessage(receipt: Pick<ChatReceipt, "number" | "subjectName">): string {
  return `❌ ${receipt.subjectName} declined Receipt #${receipt.number}.`;
}

/** Reply to "@receipts call me Ace". */
export function renamedMessage(name: string): string {
  return `🧾 Got it. You're ${name} around here.`;
}

/** Reply to "@receipts 43 right": the outcome, who settled it, and the Take Score it earned. */
export function settledMessage(
  receipt: ChatReceipt,
  settlement: { outcome: SettlementOutcome; settlerName: string; points: number | null }
): string {
  const lines = [
    `${OUTCOME_EMOJI[settlement.outcome]} RECEIPT #${receipt.number}: ${outcomeLabel(receipt.type, settlement.outcome).toUpperCase()}`,
    "",
    `${receipt.subjectName}:`,
    quote(receipt),
    ""
  ];
  if (receipt.type === "take" && settlement.points !== null) {
    lines.push(`Heat: ${flames(receipt.heat)} · +${settlement.points} Take Score`);
  }
  lines.push(`Settled by ${settlement.settlerName}`);
  return lines.join("\n");
}

// --- Take Blitz --------------------------------------------------------------

export const CROWN = "👑";

/** "👑 Dana" for whoever wears the crown, "Dana" otherwise. */
export function crownedName(name: string, crowned: boolean): string {
  return crowned ? `${CROWN} ${name}` : name;
}

/** "Sam", "Sam & Dana", "Sam, Dana & Alex". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** When the blitz window closes and when the crown is anointed, shown in the group's local time. */
export type BlitzTimes = { endsAt: number; anointAt: number; utcOffsetMinutes: number };

/** The blitz board and who wears the crown. Names on the board are plain; the copy adds the crown. */
export type BlitzResults = { board: readonly BlitzStanding[]; crown: readonly SubjectRef[] };

/** What a take logged during the blitz earned its sender. */
export type BlitzTakeResult = {
  /** Points the take earned; 0 when `blocked`. */
  points: number;
  /** The sender's blitz total, including this take. */
  total: number;
  /** Point-earning takes the sender has left. */
  left: number;
  /** Why the take earned nothing: it comes due after the anointing, or the sender used every point-earning take. */
  blocked: "late" | "cap" | null;
};

/** Reply to the first "@receipts lfg": the blitz rules, both deadlines, and the record book invite. */
export function blitzStartMessage(times: BlitzTimes, invite: { url: string; expiresInDays: number }): string {
  return [
    "🚨 24 HOUR TAKE BLITZ ACTIVATED 🚨",
    "",
    `Drop takes like "@receipts the Giants win tonight". Up to ${BLITZ_TAKE_CAP} each.`,
    "The sooner a take comes due, the more it's worth:",
    `⚡ Due today or tomorrow: ${LIGHTNING_POINTS} pts`,
    `📅 Due before the ${CROWN} is anointed: ${WEEK_POINTS} pts`,
    "Wrong takes keep half.",
    "",
    "Old takes count too. Reply to one with:",
    `🧾 "@receipts told you so" if you called it: ${CALLOUT_POINTS} pts`,
    `🚨 "@receipts exposed" if they blew it: they lose ${CALLOUT_POINTS}`,
    "",
    `Blitz ends ${formatDateTime(times.endsAt, times.utcOffsetMinutes)}.`,
    `The ${CROWN} is anointed ${formatDateTime(times.anointAt, times.utcOffsetMinutes)}.`,
    "",
    `Record book invite (expires in ${invite.expiresInDays} days):`,
    invite.url
  ].join("\n");
}

/** Reply to "@receipts lfg" after the group's one blitz has started. `holders` are the crown holders' names. */
export function blitzStatusMessage(phase: BlitzPhase, times: BlitzTimes, holders: readonly string[]): string {
  switch (phase) {
    case "live":
      return `🚨 The take blitz is already on. It ends ${formatDateTime(times.endsAt, times.utcOffsetMinutes)}.`;
    case "provisional": {
      const crown =
        holders.length > 0
          ? `${joinNames(holders.map((name) => crownedName(name, true)))} ${holders.length === 1 ? "holds" : "hold"} the crown for now.`
          : "Nobody holds the crown yet.";
      return `⏰ The take blitz is over. ${crown} It's anointed ${formatDateTime(times.anointAt, times.utcOffsetMinutes)}.`;
    }
    case "final":
      return holders.length > 0
        ? `${CROWN} The take blitz is done. All hail ${joinNames(holders)}.`
        : "🧾 The take blitz is done. Nobody won the crown.";
  }
}

/** Short confirmation for a take the sender logs about themselves during the blitz, with its temp check when it has one. */
export function blitzTakeMessage(receipt: ChatReceipt, result: BlitzTakeResult, options: { late: boolean; grade?: TakeGrade | null }): string {
  const bonus = result.points > 0 ? ` +${result.points}${result.points === LIGHTNING_POINTS ? " ⚡" : ""}` : "";
  const due = receipt.deadline ? `Due: ${formatDate(receipt.deadline)}` : "Due: no date";
  let standing: string;
  if (result.blocked === "late") {
    standing = `No blitz points: it's due after the ${CROWN} is anointed.`;
  } else if (result.blocked === "cap") {
    standing = `No blitz points: you've used all ${BLITZ_TAKE_CAP}.`;
  } else {
    const left = result.left > 0 ? `${result.left} ${result.left === 1 ? "take" : "takes"} left` : "That was your last one.";
    standing = `${receipt.subjectName}'s blitz total: ${result.total} · ${left}`;
  }
  const lines = [`🧾 #${receipt.number} LOCKED · ${receipt.subjectName}${bonus}`, quote(receipt)];
  if (options.grade) {
    lines.push(tempCheckLine(options.grade));
  }
  lines.push(`${due} · ${standing}`);
  if (receipt.deadline && receipt.dateAmbiguous) {
    lines.push(`Reply "@receipts cancel ${receipt.number}" if I read the date wrong.`);
  }
  if (options.late) {
    lines.push(LATE_LINE);
  }
  return lines.join("\n");
}

/** "🌡️ Temp check: 90° · long shot · spicy · clear-cut". */
function tempCheckLine(grade: TakeGrade): string {
  return [`🌡️ Temp check: ${takeTemp(grade)}°`, ...gradeLabels(grade)].join(" · ");
}

/** Sent when the blitz window closes: the board and the provisional crown. */
export function blitzOverMessage(results: BlitzResults, times: BlitzTimes, url: string): string {
  if (results.board.length === 0) {
    return ["⏰ TAKE BLITZ OVER", "", `Nobody made a single take. No ${CROWN} this time.`, url].join("\n");
  }
  const holders = holderNames(results);
  return [
    "⏰ TAKE BLITZ OVER",
    "",
    ...boardLines(results),
    "",
    holders.length > 0 ? `The ${CROWN} goes to ${joinNames(holders)}… for now.` : `Nobody has a point, so nobody gets the ${CROWN} yet.`,
    `Wrong takes keep half. The ${CROWN} is anointed ${formatDateTime(times.anointAt, times.utcOffsetMinutes)}.`,
    url
  ].join("\n");
}

/** Sent a day before the anointing: who holds the crown and which blitz takes still need settling. */
export function lastCallMessage(results: BlitzResults, unsettled: readonly number[], times: BlitzTimes, url: string): string {
  const holders = results.board.filter((standing) => results.crown.includes(standing.subjectRef));
  const lines = ["👑 LAST CALL", "", `The ${CROWN} is anointed ${formatDateTime(times.anointAt, times.utcOffsetMinutes)}.`];
  if (holders.length > 0) {
    const names = joinNames(holders.map((standing) => crownedName(standing.name, true)));
    lines.push(`${holders.length === 1 ? "Current holder" : "Current holders"}: ${names} (${points(holders[0].total)})`);
  } else {
    lines.push("Nobody holds it yet.");
  }
  lines.push("");
  if (unsettled.length > 0) {
    lines.push(`Still unsettled: ${unsettled.map((number) => `#${number}`).join(", ")}`, "Settle them or they burn. Unsettled takes keep half.");
  } else {
    lines.push("Every blitz take is settled.");
  }
  lines.push(url);
  return lines.join("\n");
}

/** Sent when the crown is anointed: the final board. */
export function anointedMessage(results: BlitzResults, url: string): string {
  const holders = holderNames(results);
  if (holders.length === 0) {
    return ["👑 THE CROWN IS ANOINTED", "", `Nobody scored a single point, so the ${CROWN} stays in the vault.`, url].join("\n");
  }
  return ["👑 THE CROWN IS ANOINTED", "", `All hail ${joinNames(holders)}.`, "", ...boardLines(results), url].join("\n");
}

/** Announces the crown changing hands, or null when the holders are the same. Takes plain names. */
export function crownChangeMessage(before: readonly string[], after: readonly string[]): string | null {
  const had = new Set(before);
  const has = new Set(after);
  if (had.size === has.size && before.every((name) => has.has(name))) {
    return null;
  }
  if (has.size === 0) {
    return `${CROWN} Nobody holds the crown now.`;
  }
  if (had.size === 0) {
    return `${CROWN} ${joinNames(after)} ${after.length === 1 ? "takes" : "take"} the crown.`;
  }
  const added = after.filter((name) => !had.has(name));
  if (added.length > 0 && before.every((name) => has.has(name))) {
    return `${CROWN} ${joinNames(added)} ${added.length === 1 ? "ties" : "tie"} ${joinNames(before)} for the crown.`;
  }
  if (added.length === 0) {
    return after.length === 1 ? `${CROWN} ${after[0]} now holds the crown alone.` : `${CROWN} ${joinNames(after)} now share the crown.`;
  }
  return `${CROWN} CROWN STOLEN. ${joinNames(after)} ${after.length === 1 ? "takes" : "take"} it from ${joinNames(before)}.`;
}

function points(total: number): string {
  return `${total} ${total === 1 ? "pt" : "pts"}`;
}

function holderNames(results: BlitzResults): string[] {
  return results.board.filter((standing) => results.crown.includes(standing.subjectRef)).map((standing) => standing.name);
}

/** "1. 👑 Sam: 18 pts (5 takes)" for each person on the board. */
function boardLines(results: BlitzResults): string[] {
  return results.board.map(
    (standing, index) =>
      `${index + 1}. ${crownedName(standing.name, results.crown.includes(standing.subjectRef))}: ${points(standing.total)} (${standing.takes} ${standing.takes === 1 ? "take" : "takes"})`
  );
}

// --- Callouts ------------------------------------------------------------------

/** Reply to "@receipts exposed": the old take, on the record as its author's. `blitz` is set during the blitz. */
export function exposedMessage(receipt: ChatReceipt, options: { exposerName: string; blitz: BlitzTakeResult | null; late: boolean }): string {
  const lines = [
    "🚨 EXPOSED",
    `On ${formatDate(receipt.madeOn)}, ${receipt.subjectName} said:`,
    quote(receipt),
    "",
    `Exposed by ${options.exposerName} · Receipt #${receipt.number}`,
    `Was ${receipt.subjectName} wrong? Reply "@receipts ${receipt.number} wrong" or "@receipts ${receipt.number} right".`
  ];
  const { blitz } = options;
  if (blitz?.blocked === "cap") {
    lines.push(`No blitz points: ${options.exposerName} has used all ${BLITZ_TAKE_CAP}.`);
  } else if (blitz) {
    const left = blitz.left > 0 ? `${options.exposerName} has ${blitz.left} ${blitz.left === 1 ? "take" : "takes"} left.` : `That was ${options.exposerName}'s last one.`;
    lines.push(`If it was wrong, ${receipt.subjectName} loses ${blitz.points} blitz points. ${left}`);
  }
  if (options.late) {
    lines.push(LATE_LINE);
  }
  return lines.join("\n");
}

/** Reply to "@receipts told you so": the sender's old take, on the record for the group to confirm. */
export function toldYouSoMessage(receipt: ChatReceipt, options: { blitz: BlitzTakeResult | null; late: boolean }): string {
  const lines = [
    "🧾 TOLD YOU SO",
    `On ${formatDate(receipt.madeOn)}, ${receipt.subjectName} said:`,
    quote(receipt),
    "",
    `Receipt #${receipt.number} · Was ${receipt.subjectName} right? Reply "@receipts ${receipt.number} right" or "@receipts ${receipt.number} wrong".`
  ];
  const { blitz } = options;
  if (blitz?.blocked === "cap") {
    lines.push(`No blitz points: you've used all ${BLITZ_TAKE_CAP}.`);
  } else if (blitz) {
    const left = blitz.left > 0 ? `${blitz.left} ${blitz.left === 1 ? "take" : "takes"} left` : "That was your last one.";
    lines.push(`${receipt.subjectName} +${blitz.points} if it holds up · blitz total: ${blitz.total} · ${left}`);
  }
  if (options.late) {
    lines.push(LATE_LINE);
  }
  return lines.join("\n");
}
