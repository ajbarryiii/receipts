// What the homepage teaches: the chat commands and receipt types, as data.
// Tests run every example through the parser so the instructions never drift from what the bot understands.

import type { BotCommand } from "./parse";
import type { ReceiptType } from "./types";

/** One line to text the bot. */
export type GuideCommand = {
  /** Exactly what to send, starting with "@receipts". */
  text: string;
  /** Sent as a native iMessage Reply to another message. */
  reply: boolean;
  /** What happens, in a sentence or two. */
  effect: string;
  /** The command this example demonstrates. */
  kind: BotCommand["kind"];
};

export type GuideCommandGroup = {
  title: string;
  commands: readonly GuideCommand[];
};

export type GuideReceiptType = {
  type: ReceiptType;
  /** The tag to use, e.g. "#take". Null for untagged receipts, whose type is inferred. */
  tag: string | null;
  summary: string;
  /** A full message that logs this type. */
  example: string;
};

export const COMMAND_GUIDE: readonly GuideCommandGroup[] = [
  {
    title: "Lock it in",
    commands: [
      {
        text: "@receipts #take Dana says the Giants win the division by Oct 1 2027",
        reply: false,
        effect: "Logs a take about Dana, due Oct 1 2027. The bot answers with its receipt number.",
        kind: "create"
      },
      {
        text: "@receipts #take by Apr 15 2027",
        reply: true,
        effect: "Reply to a friend's message to nominate their exact words. It counts once they accept.",
        kind: "capture"
      },
      {
        text: "@receipts #promise by Dec 31",
        reply: true,
        effect: "Reply to your own message to put it on the record right away.",
        kind: "capture"
      },
      {
        text: "@receipts exposed",
        reply: true,
        effect: "Reply to a friend's old message to put it on the record as their take. No accepting it. The group settles whether they were wrong.",
        kind: "exposed"
      },
      {
        text: "@receipts told you so",
        reply: true,
        effect: "Reply to your own old message to claim you called it. Someone else confirms it.",
        kind: "toldYouSo"
      },
      {
        text: "@receipts cancel 43",
        reply: false,
        effect: "Whoever logged #43 can take it back within 24 hours.",
        kind: "cancel"
      }
    ]
  },
  {
    title: "Answer a nomination",
    commands: [
      {
        text: "@receipts accept 43",
        reply: false,
        effect: "The author of the nominated message puts #43 on the record.",
        kind: "accept"
      },
      {
        text: "@receipts reject 43",
        reply: false,
        effect: "Or keeps it off the record. Rejected nominations never score.",
        kind: "reject"
      },
      {
        text: "@receipts nominations",
        reply: false,
        effect: "Lists nominations still waiting on an answer.",
        kind: "nominations"
      }
    ]
  },
  {
    title: "Settle up",
    commands: [
      {
        text: "@receipts 43 right",
        reply: false,
        effect: "Settles #43 as right, or wrong if it missed. Anyone can settle except the take's author and whoever nominated it.",
        kind: "settle"
      },
      {
        text: "@receipts 43 void",
        reply: false,
        effect: "Calls it off. Nobody scores.",
        kind: "settle"
      }
    ]
  },
  {
    title: "Look things up",
    commands: [
      {
        text: "@receipts upcoming",
        reply: false,
        effect: "The next receipts coming due.",
        kind: "upcoming"
      },
      {
        text: "@receipts list",
        reply: false,
        effect: "Open receipts in the group.",
        kind: "list"
      },
      {
        text: "@receipts mine",
        reply: false,
        effect: "Open receipts about you. Link your texts with join first.",
        kind: "mine"
      },
      {
        text: "@receipts 43",
        reply: false,
        effect: "Shows receipt #43 with a link to its page.",
        kind: "show"
      },
      {
        text: "@receipts help",
        reply: false,
        effect: "A command cheat sheet, right in the chat.",
        kind: "help"
      }
    ]
  },
  {
    title: "You and your group",
    commands: [
      {
        text: "@receipts lfg",
        reply: false,
        effect:
          "Kicks off the group's one-time 24-hour take blitz. Takes that come due soonest earn the most points, and whoever has the most a week later gets the 👑.",
        kind: "lfg"
      },
      {
        text: "@receipts setup",
        reply: false,
        effect: "A 7-day invite link to the group's record book on this site.",
        kind: "setup"
      },
      {
        text: "@receipts join",
        reply: false,
        effect: "A 15-minute link that connects your texts to your web account.",
        kind: "join"
      },
      {
        text: "@receipts call me Ace",
        reply: false,
        effect: "Sets the name the bot uses for you. No account needed.",
        kind: "rename"
      }
    ]
  }
];

export const RECEIPT_TYPE_GUIDE: readonly GuideReceiptType[] = [
  {
    type: "take",
    tag: "#take",
    summary: "A prediction that turns out right or wrong. The group rates its heat, and correct takes score.",
    example: "@receipts #take Dana says the Giants win the division by Oct 1 2027"
  },
  {
    type: "promise",
    tag: "#promise",
    summary: "Something someone swore they'd do.",
    example: "@receipts #promise Riley: I'm running a half marathon by June 1 2027"
  },
  {
    type: "bet",
    tag: "#bet",
    summary: "A wager with stakes attached.",
    example: "@receipts #bet Dana says the Knicks make the playoffs, loser buys wings"
  },
  {
    type: "conditional",
    tag: "#conditional",
    summary: "An if-this-then-that, settled once the \"if\" plays out.",
    example: "@receipts #conditional Sam says if the Jets make the playoffs, the Jets tattoo happens"
  },
  {
    type: "generic",
    tag: null,
    summary: "Anything else worth keeping. Skip the tag and the bot infers the type from the wording.",
    example: "@receipts Sam: pineapple belongs on pizza"
  }
];
