import { Link } from "lakebed/client";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { formatDate } from "../shared/dates";
import { flames, quoteStatement, statusLabel, typeLabel } from "../shared/format";
import { takeTemp } from "../shared/jev";
import type { Card } from "./api";

const DAY = 24 * 60 * 60 * 1000;

export function Page({ eyebrow, title, actions, children }: { eyebrow?: ComponentChildren; title: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-2 font-mono text-xs uppercase tracking-widest text-amber-400">{eyebrow}</p> : null}
          <h1 className="text-4xl font-black tracking-tight text-stone-50 sm:text-5xl">{title}</h1>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Section({
  id,
  title,
  count,
  children,
  hint
}: {
  id?: string;
  title: string;
  count?: number;
  hint?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section className="mb-10 scroll-mt-6" id={id}>
      <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-stone-800 pb-2">
        <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-stone-300">
          {title}
          {count !== undefined ? <span className="ml-2 text-stone-500">{count}</span> : null}
        </h2>
        {hint ? <p className="text-xs text-stone-500">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p className="rounded-lg border border-dashed border-stone-800 px-4 py-6 text-center text-sm text-stone-500">{children}</p>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <p className="animate-pulse font-mono text-sm text-stone-500">{label}…</p>;
}

export function Flames({ heat, className = "" }: { heat: number | null; className?: string }) {
  return heat === null ? <span className={`text-stone-500 ${className}`}>unrated</span> : <span className={className}>{flames(heat)}</span>;
}

type Tone = "stone" | "amber" | "emerald" | "rose" | "sky" | "violet";

const TONES: Record<Tone, string> = {
  stone: "border-stone-400 text-stone-600",
  amber: "border-amber-600 text-amber-700",
  emerald: "border-emerald-600 text-emerald-700",
  rose: "border-rose-600 text-rose-700",
  sky: "border-sky-600 text-sky-700",
  violet: "border-violet-600 text-violet-700"
};

export function Stamp({ tone, children }: { tone: Tone; children: ComponentChildren }) {
  return (
    <span className={`inline-flex items-center rounded border-2 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function statusTone(status: Card["status"]): Tone {
  switch (status) {
    case "right":
      return "emerald";
    case "wrong":
      return "rose";
    case "nominated":
      return "sky";
    case "pending":
      return "amber";
    default:
      return "stone";
  }
}

export function StatusStamp({ card }: { card: Pick<Card, "type" | "status" | "subjectName"> }) {
  return <Stamp tone={statusTone(card.status)}>{statusLabel(card)}</Stamp>;
}

/** "Due Oct 1, 2027 · in 6 days", "Overdue by 2 days", "No due date". */
export function dueText(card: Pick<Card, "deadline" | "dueAt" | "status">, now = Date.now()): string {
  if (!card.deadline || card.dueAt === null) return "No due date";
  const settled = card.status === "right" || card.status === "wrong" || card.status === "void";
  const date = formatDate(card.deadline);
  if (settled) return `Due ${date}`;
  const days = Math.round((card.dueAt - now) / DAY);
  if (days < 0) return `Due ${date} · ${-days}d overdue`;
  if (days === 0) return `Due ${date} · today`;
  return `Due ${date} · in ${days}d`;
}

export function receiptPath(card: Pick<Card, "groupId" | "number">): string {
  return `/g/${card.groupId}/r/${card.number}`;
}

export function profilePath(groupId: string, subjectRef: string): string {
  return `/g/${groupId}/p/${encodeURIComponent(subjectRef)}`;
}

/** A receipt slip: the paper-looking card used in every list. */
export function Slip({ card, footer }: { card: Card; footer?: ComponentChildren }) {
  return (
    <article className="rounded-md bg-stone-100 text-stone-900 shadow-lg shadow-black/40 ring-1 ring-stone-300">
      <Link className="block px-4 pb-3 pt-4 hover:bg-white" to={receiptPath(card)}>
        <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-widest text-stone-500">
          <span>
            #{card.number} · {typeLabel(card.type)}
            {card.capture === "reply" ? " · original" : ""}
          </span>
          <StatusStamp card={card} />
        </div>
        <p className="font-bold">{card.subjectName}</p>
        <p className="mt-1 font-serif text-lg leading-snug">{quoteStatement(card.statement, card.capture === "reply")}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-stone-400 pt-2 font-mono text-xs text-stone-600">
          <span>{dueText(card)}</span>
          {card.type === "take" ? (
            <span>
              {card.tempCheck ? <span title="Temp check">🌡️ {takeTemp(card.tempCheck)}° · </span> : null}
              <Flames heat={card.heat} />
            </span>
          ) : null}
        </div>
        {card.nomination && card.nomination.state === "pending" ? (
          <p className="mt-2 font-mono text-xs text-sky-700">
            Nominated by {card.nomination.nominatedByName} · awaiting {card.subjectName}
          </p>
        ) : null}
        {card.callout ? (
          <p className={card.callout.kind === "exposed" ? "mt-2 font-mono text-xs text-rose-700" : "mt-2 font-mono text-xs text-emerald-700"}>
            {card.callout.kind === "exposed" ? `🚨 Exposed by ${card.callout.byName}` : "🧾 Told you so"}
          </p>
        ) : null}
      </Link>
      {footer ? <div className="border-t border-dashed border-stone-400 px-4 py-3">{footer}</div> : null}
    </article>
  );
}

export function SlipGrid({ cards, empty, footer }: { cards: Card[]; empty: ComponentChildren; footer?: (card: Card) => ComponentChildren }) {
  if (cards.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {cards.map((card) => (
        <Slip card={card} footer={footer?.(card)} key={card.id} />
      ))}
    </div>
  );
}

type ButtonTone = "primary" | "ghost" | "good" | "bad";

const BUTTONS: Record<ButtonTone, string> = {
  primary: "bg-amber-400 text-stone-950 hover:bg-amber-300",
  ghost: "border border-stone-600 text-stone-200 hover:border-stone-300",
  good: "bg-emerald-600 text-white hover:bg-emerald-500",
  bad: "bg-rose-700 text-white hover:bg-rose-600"
};

export function Button({
  tone = "primary",
  onClick,
  disabled,
  children,
  type = "button"
}: {
  tone?: ButtonTone;
  onClick?: () => void;
  disabled?: boolean;
  children: ComponentChildren;
  type?: "button" | "submit";
}) {
  return (
    <button
      className={`rounded-md px-3 py-1.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${BUTTONS[tone]}`}
      disabled={disabled}
      type={type}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Runs a mutation with busy and error state. */
export function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    setBusy(true);
    setError(null);
    try {
      return { ok: true, value: await work() };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="mt-2 text-sm text-rose-400" role="alert">
      {error}
    </p>
  ) : null;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatHeat(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} 🔥`;
}
