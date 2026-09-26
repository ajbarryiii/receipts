import { Link, useParams } from "lakebed/client";
import { useEffect, useState } from "preact/hooks";
import { formatDate } from "../../shared/dates";
import { flames, outcomeLabel, quoteStatement, typeLabel } from "../../shared/format";
import { TAKE_POINTS, UNRATED_TAKE_POINTS } from "../../shared/scoring";
import { SETTLEMENT_OUTCOMES, type SettlementOutcome } from "../../shared/types";
import { client, type Detail } from "../api";
import { Button, dueText, ErrorText, Flames, Loading, Page, profilePath, Section, StatusStamp, useRunner } from "../ui";
import { NominationButtons } from "./group";

export function ReceiptPage() {
  const { groupId = "", number = "" } = useParams<{ groupId?: string; number?: string }>();
  const detail = client.useQuery("receipt", groupId, Number(number));
  if (detail === undefined) return <Loading />;
  if (detail === null) {
    return (
      <Page title="No such receipt">
        <p className="text-stone-400">
          It was canceled, or this isn't your group. <Link className="underline" to={`/g/${groupId}`}>Back to the record book</Link>
        </p>
      </Page>
    );
  }
  return <ReceiptView detail={detail} key={detail.card.id} />;
}

function ReceiptView({ detail }: { detail: Detail }) {
  const { card } = detail;
  return (
    <Page
      eyebrow={
        <Link className="hover:text-amber-200" to={`/g/${card.groupId}`}>
          ← {detail.groupName}
        </Link>
      }
      title={`Receipt #${card.number}`}
    >
      <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
        <div>
          <ReceiptPaper detail={detail} />
          {detail.canRespond ? (
            <div className="mt-4 rounded-md bg-sky-50 p-4 ring-1 ring-sky-300">
              <NominationButtons card={card} />
            </div>
          ) : null}
        </div>
        <div>
          {card.type === "take" ? <HeatPanel detail={detail} /> : null}
          {detail.canSettle ? (
            <SettlePanel detail={detail} />
          ) : detail.settleBlockedReason ? (
            <Section title="Settle it">
              <p className="text-sm text-stone-500">{detail.settleBlockedReason}</p>
            </Section>
          ) : null}
          {detail.canEditDeadline ? <DeadlinePanel detail={detail} /> : null}
          {detail.settlements.length > 0 ? (
            <Section title="Settlement history">
              <ul className="space-y-2 text-sm text-stone-300">
                {detail.settlements.map((settlement) => (
                  <li key={settlement.at}>
                    <span className="font-bold">{outcomeLabel(card.type, settlement.outcome)}</span> · {settlement.settledByName} ·{" "}
                    {new Date(settlement.at).toLocaleDateString()}
                    {settlement.notes ? <p className="text-stone-500">"{settlement.notes}"</p> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>
    </Page>
  );
}

function ReceiptPaper({ detail }: { detail: Detail }) {
  const { card } = detail;
  const madeOn = formatDate(card.madeOn);
  return (
    <article className="rounded-md bg-stone-100 px-6 py-6 font-mono text-sm text-stone-800 shadow-2xl shadow-black/50">
      <div className="mb-4 flex items-center justify-between border-b border-dashed border-stone-400 pb-3 text-xs uppercase tracking-widest text-stone-500">
        <span>
          🧾 {typeLabel(card.type)} · #{card.number}
        </span>
        <StatusStamp card={card} />
      </div>
      <Link className="text-base font-bold text-stone-900 underline-offset-4 hover:underline" to={profilePath(card.groupId, card.subjectRef)}>
        {card.subjectName}
      </Link>
      <p className="mt-2 font-serif text-2xl leading-snug text-stone-950">{quoteStatement(card.statement, card.capture === "reply")}</p>

      <p className="mt-4 text-xs text-stone-600">
        {card.capture === "reply"
          ? `Original receipt: captured directly from an iMessage sent by ${card.subjectName} on ${madeOn}.`
          : `Recorded claim: entered by ${detail.createdByName} on ${madeOn}.`}
        {card.nomination ? ` Nominated by ${card.nomination.nominatedByName}.` : ""}
        {card.callout?.kind === "exposed" ? ` Exposed by ${card.callout.byName}.` : ""}
        {card.callout?.kind === "told_you_so" ? ` ${card.subjectName} says they called it.` : ""}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-dashed border-stone-400 pt-4 text-xs">
        <dt className="text-stone-500">DUE</dt>
        <dd>
          {dueText(card)}
          {detail.dateAmbiguous ? " (best guess)" : ""}
        </dd>
        {card.type === "take" ? (
          <>
            <dt className="text-stone-500">HEAT</dt>
            <dd>
              <Flames heat={card.heat} /> {card.voteCount > 0 ? `(${card.voteCount} vote${card.voteCount === 1 ? "" : "s"})` : ""}
            </dd>
          </>
        ) : null}
        {detail.points !== null ? (
          <>
            <dt className="text-stone-500">TAKE SCORE</dt>
            <dd className="font-bold">+{detail.points}</dd>
          </>
        ) : null}
        {card.nomination ? (
          <>
            <dt className="text-stone-500">NOMINATION</dt>
            <dd>{card.nomination.state === "pending" ? `Awaiting ${card.subjectName}` : card.nomination.state}</dd>
          </>
        ) : null}
      </dl>

      <p className="mt-4 border-t border-dashed border-stone-400 pt-3 text-[11px] text-stone-500">Logged via: {detail.originalText}</p>
    </article>
  );
}

function HeatPanel({ detail }: { detail: Detail }) {
  const vote = client.useMutation("voteHeat");
  const { busy, error, run } = useRunner();
  const { card } = detail;
  return (
    <Section title="Heat" hint={card.heat === null ? "Unrated" : `${flames(card.heat)} = +${TAKE_POINTS[card.heat]} if right`}>
      {detail.voteBlockedReason ? (
        <p className="mb-3 text-sm text-stone-500">{detail.voteBlockedReason}</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-stone-400">How bold is this take right now? The median vote is the official heat.</p>
          <div className="mb-3 flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                className={`rounded-md border px-2 py-1 text-sm transition ${
                  detail.myVote === value ? "border-amber-400 bg-amber-400/20" : "border-stone-700 hover:border-amber-400"
                }`}
                disabled={busy}
                key={value}
                title={`${value} flame${value === 1 ? "" : "s"}: +${TAKE_POINTS[value]} if right`}
                type="button"
                onClick={() => void run(() => vote(card.id, value))}
              >
                {flames(value)}
              </button>
            ))}
          </div>
          <ErrorText error={error} />
        </>
      )}
      {detail.votes.length > 0 ? (
        <ul className="space-y-1 text-sm text-stone-400">
          {detail.votes.map((entry) => (
            <li key={entry.name}>
              {entry.name}
              {entry.isMine ? " (you)" : ""}: {flames(entry.flames)}
            </li>
          ))}
        </ul>
      ) : null}
      {card.heat === null && card.status !== "nominated" ? (
        <p className="mt-2 text-xs text-stone-600">Unrated takes score +{UNRATED_TAKE_POINTS} if right.</p>
      ) : null}
    </Section>
  );
}

function SettlePanel({ detail }: { detail: Detail }) {
  const settle = client.useMutation("settleReceipt");
  const [outcome, setOutcome] = useState<SettlementOutcome | null>(null);
  const [notes, setNotes] = useState("");
  const { busy, error, run } = useRunner();
  const { card } = detail;
  const correcting = card.status !== "pending";

  async function submit() {
    if (!outcome) return;
    if ((await run(() => settle(card.id, outcome, notes.trim() || null))).ok) {
      setOutcome(null);
      setNotes("");
    }
  }

  return (
    <Section
      title={correcting ? "Correct the outcome" : "Settle it"}
      hint={correcting ? "Owner only. Heat stays locked." : `Or text "@receipts ${card.number} right" in the chat`}
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {SETTLEMENT_OUTCOMES.map((value) => (
          <button
            className={`rounded-md border px-3 py-1.5 text-sm font-bold transition ${
              outcome === value ? "border-amber-400 bg-amber-400 text-stone-950" : "border-stone-700 text-stone-200 hover:border-amber-400"
            }`}
            key={value}
            type="button"
            onClick={() => setOutcome(value)}
          >
            {outcomeLabel(card.type, value)}
          </button>
        ))}
      </div>
      {outcome ? (
        <div>
          <textarea
            className="mb-2 w-full rounded-md border border-stone-700 bg-stone-900 p-2 text-sm text-stone-100 outline-none focus:border-amber-400"
            maxLength={500}
            placeholder="Evidence or notes (optional)"
            rows={2}
            value={notes}
            onInput={(event) => setNotes(event.currentTarget.value)}
          />
          <Button disabled={busy} onClick={() => void submit()}>
            Mark {outcomeLabel(card.type, outcome).toLowerCase()}
          </Button>
        </div>
      ) : null}
      <ErrorText error={error} />
    </Section>
  );
}

function DeadlinePanel({ detail }: { detail: Detail }) {
  const setDeadline = client.useMutation("setDeadline");
  const [value, setValue] = useState(detail.card.deadline ?? "");
  const { busy, error, run } = useRunner();
  const changed = value !== (detail.card.deadline ?? "");

  useEffect(() => {
    setValue(detail.card.deadline ?? "");
  }, [detail.card.deadline]);

  async function clear() {
    if ((await run(() => setDeadline(detail.card.id, null))).ok) setValue("");
  }

  return (
    <Section title="Deadline" hint={detail.dateAmbiguous ? "The bot guessed this date" : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-sm text-stone-100 outline-none focus:border-amber-400"
          type="date"
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <Button disabled={busy || !changed || !value} onClick={() => void run(() => setDeadline(detail.card.id, value))}>
          Save
        </Button>
        {detail.card.deadline ? (
          <Button tone="ghost" disabled={busy} onClick={() => void clear()}>
            Clear
          </Button>
        ) : null}
      </div>
      <ErrorText error={error} />
    </Section>
  );
}
