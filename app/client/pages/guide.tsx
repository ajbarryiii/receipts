import { Link, SignInWithGoogle, useAuth } from "lakebed/client";
import type { ComponentChildren } from "preact";
import { DUE_HOUR, formatDate } from "../../shared/dates";
import { confirmationMessage, flames, reminderMessage, settleWords, typeLabel, type ChatReceipt } from "../../shared/format";
import { COMMAND_GUIDE, RECEIPT_TYPE_GUIDE, type GuideCommand } from "../../shared/guide";
import { TAKE_POINTS, UNRATED_TAKE_POINTS } from "../../shared/scoring";
import { Page, Section } from "../ui";

const START_STEPS = [
  ["Add the bot", "Add the Receipts iMessage account to your group chat. It only ever sees messages that mention @receipts."],
  ["Open the record book", 'Send "@receipts setup", open the invite link it replies with, and sign in with Google. The first person in owns the group.'],
  ["Claim your texts", 'Everyone sends "@receipts join" from their own phone and opens their link, so receipts about them land on their profile.'],
  ["Start logging", "Tag a take, promise, or bet. When it comes due, the bot brings it back to the chat to settle."]
] as const;

const WEBSITE_FEATURES = [
  ["Rate the heat", "Give open takes 1 to 5 🔥. The median vote is the official heat. Voting closes at the deadline or at settlement, and nobody rates their own take."],
  ["Settle receipts", "Mark a receipt right, wrong, or void from its page and leave a note. Only the group owner can change a settled outcome, and never on their own take."],
  ["Answer nominations", "Accept or reject the messages your group nominated from you."],
  ["Fix deadlines", "Set or clear the due date on any open receipt. A new date re-arms the reminder."],
  ["Claim your name", 'If someone logged takes about "Dana" before you joined, open that profile and claim the name as yours.'],
  ["Check the standings", "Rank everyone by Take Score, with right, wrong, and pending counts, accuracy, and average heat."]
] as const;

const DUE_TIME = `${DUE_HOUR % 12 || 12} ${DUE_HOUR < 12 ? "a.m." : "p.m."}`;

const GOOD_TO_KNOW = [
  `Reminders land in the chat where the receipt was made, at ${DUE_TIME} on the due date.`,
  'Dates can be loose: "by Oct 1 2027", "by March", "by Friday", "in 2 weeks". When the bot has to guess, it says so. Cancel within 24 hours or fix the date on the website.',
  "No date? That's fine. It stays open until someone settles it.",
  "Each message can only be captured once. Replying to it again points to the existing receipt.",
  "The same open take about the same person with the same deadline is never logged twice.",
  'iMessage only records the first message of a reply thread. If the thread already has replies, spell it out instead: "@receipts #take Dana: the take by Oct 1 2027".'
] as const;

const SECTIONS = [
  ["get-started", "Get started"],
  ["what-to-log", "What to log"],
  ["commands", "Chat commands"],
  ["website", "On the website"],
  ["scoring", "Scoring"],
  ["good-to-know", "Good to know"]
] as const;

const DEMO: ChatReceipt = {
  number: 43,
  type: "take",
  status: "pending",
  capture: "manual",
  subjectName: "Dana",
  statement: "The Giants win the division",
  madeOn: "2026-09-25",
  deadline: "2027-10-01",
  dateAmbiguous: false,
  heat: null
};

function Bubble({ from, mine = false, paper = false, children }: { from?: string; mine?: boolean; paper?: boolean; children: ComponentChildren }) {
  const tone = paper ? "bg-stone-100 font-mono text-xs text-stone-900" : mine ? "bg-sky-500 text-white" : "bg-stone-800 text-stone-100";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      {from ? <p className="mb-1 px-3 text-xs text-stone-500">{from}</p> : null}
      <p className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3.5 py-2 text-sm ${tone}`}>{children}</p>
    </div>
  );
}

/** A mock group chat showing a take being logged and resurfaced, in the bot's real words. */
export function ChatDemo() {
  const url = `${typeof window === "undefined" ? "" : window.location.host}/g/demo/r/${DEMO.number}`;
  return (
    <div className="grid gap-3 rounded-3xl border border-stone-800 bg-stone-900/60 p-4 shadow-2xl shadow-black/50 sm:p-5">
      <p className="text-center text-xs text-stone-500">{formatDate(DEMO.madeOn)}</p>
      <Bubble from="Dana">Giants win the division next year. Screenshot it.</Bubble>
      <Bubble mine>@receipts #take Dana says the Giants win the division by Oct 1 2027</Bubble>
      <Bubble from="Receipts" paper>
        {confirmationMessage(DEMO, { today: DEMO.madeOn, late: false })}
      </Bubble>
      <p className="text-center text-xs text-stone-500">{formatDate(DEMO.deadline ?? DEMO.madeOn)}</p>
      <Bubble from="Receipts" paper>
        {reminderMessage({ ...DEMO, heat: 4 }, url)}
      </Bubble>
    </div>
  );
}

function CommandRow({ command }: { command: GuideCommand }) {
  return (
    <li className="grid gap-1 py-3 sm:grid-cols-2 sm:gap-6">
      <div className="min-w-0">
        {command.reply ? (
          <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-sky-400">↩ Send as a reply</p>
        ) : null}
        <code className="break-words font-mono text-sm text-amber-300">{command.text}</code>
      </div>
      <p className="text-sm text-stone-400">{command.effect}</p>
    </li>
  );
}

/** Everything a group needs to know to use Receipts, from setup to scoring. */
export function HowItWorks() {
  const auth = useAuth();
  return (
    <div>
      <nav aria-label="On this page" className="mb-10 flex flex-wrap gap-2">
        {SECTIONS.map(([id, title]) => (
          <a
            className="rounded-full border border-stone-800 px-3 py-1 font-mono text-xs uppercase tracking-widest text-stone-400 hover:border-amber-400 hover:text-stone-100"
            href={`#${id}`}
            key={id}
          >
            {title}
          </a>
        ))}
      </nav>

      <Section id="get-started" title="Get started">
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {START_STEPS.map(([title, body], index) => (
            <li className="rounded-md bg-stone-100 p-4 font-mono text-sm text-stone-800 shadow-lg shadow-black/40" key={title}>
              <p className="mb-2 font-bold">
                {String(index + 1).padStart(2, "0")} {title.toUpperCase()}
              </p>
              <p className="text-stone-600">{body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="what-to-log" title="What to log" hint="Start any message with @receipts">
        <div className="grid gap-4 sm:grid-cols-2">
          {RECEIPT_TYPE_GUIDE.map((entry) => {
            const [yes, no] = settleWords(entry.type);
            return (
              <article className="rounded-md border border-stone-800 bg-stone-900 p-4" key={entry.type}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-lg font-bold text-stone-100">{typeLabel(entry.type)}</h3>
                  <span className="font-mono text-xs text-amber-400">{entry.tag ?? "no tag"}</span>
                </div>
                <p className="mb-3 text-sm text-stone-400">{entry.summary}</p>
                <code className="mb-3 block break-words rounded bg-stone-950 px-3 py-2 font-mono text-xs text-amber-300">{entry.example}</code>
                <p className="font-mono text-xs text-stone-500">
                  Settles as {yes} / {no} / void
                </p>
              </article>
            );
          })}
        </div>
        <p className="mt-4 text-sm text-stone-500">
          Skip the tag and the bot guesses: "bets" or "loser buys" makes a bet, "swears" or "promises" a promise, "if" a conditional, and
          a date or "will" a take.
        </p>
      </Section>

      <Section id="commands" title="Chat commands" hint="Use any receipt number in place of 43">
        <div className="grid gap-6">
          {COMMAND_GUIDE.map((group) => (
            <div key={group.title}>
              <h3 className="mb-1 font-bold text-stone-100">{group.title}</h3>
              <ul className="divide-y divide-stone-900">
                {group.commands.map((command) => (
                  <CommandRow command={command} key={command.text} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section id="website" title="On the website">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {WEBSITE_FEATURES.map(([title, body]) => (
            <li className="rounded-md border border-stone-800 bg-stone-900 p-4" key={title}>
              <p className="mb-1 font-bold text-stone-100">{title}</p>
              <p className="text-sm text-stone-400">{body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="scoring" title="Scoring">
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div className="grid gap-3 text-stone-400">
            <p>
              Takes are how you climb the standings. A take that comes true earns Take Score points based on its official heat, so the
              bolder the call, the bigger the payoff.
            </p>
            <p>
              Wrong and void takes earn nothing. A right take nobody rated earns {UNRATED_TAKE_POINTS}. Promises, bets, and conditionals
              stay on the record but don't score.
            </p>
          </div>
          <table className="w-full overflow-hidden rounded-md bg-stone-100 font-mono text-sm text-stone-800 shadow-lg shadow-black/40">
            <thead className="border-b border-dashed border-stone-400 text-xs uppercase tracking-widest text-stone-500">
              <tr>
                <th className="px-4 py-2 text-left">Heat</th>
                <th className="px-4 py-2 text-right">Right take earns</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(TAKE_POINTS).map(([heat, points]) => (
                <tr key={heat}>
                  <td className="px-4 py-1.5">{flames(Number(heat))}</td>
                  <td className="px-4 py-1.5 text-right font-bold">+{points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="good-to-know" title="Good to know">
        <ul className="grid list-disc gap-2 pl-5 text-sm text-stone-400">
          {GOOD_TO_KNOW.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Section>

      <div className="flex flex-wrap items-center gap-4 rounded-md border border-dashed border-stone-700 px-5 py-4">
        {auth.isSignedIn ? (
          <>
            <p className="text-stone-300">Ready to check the standings?</p>
            <Link className="rounded-md bg-amber-400 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-amber-300" to="/">
              Your groups
            </Link>
          </>
        ) : (
          <>
            <p className="text-stone-300">Got an invite link? Sign in to open your group's record book.</p>
            <SignInWithGoogle className="rounded-md bg-amber-400 px-4 py-2 text-sm font-bold text-stone-950 hover:bg-amber-300" />
          </>
        )}
      </div>
    </div>
  );
}

export function GuidePage() {
  return (
    <Page eyebrow="The record book for your group chat" title="How it works">
      <HowItWorks />
    </Page>
  );
}
