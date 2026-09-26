import { Link, useAuth, useParams } from "lakebed/client";
import { useState } from "preact/hooks";
import { crownedName } from "../../shared/format";
import { client, type Card, type Group } from "../api";
import {
  Button,
  Empty,
  ErrorText,
  formatHeat,
  formatPercent,
  Loading,
  Page,
  profilePath,
  Section,
  SlipGrid,
  useRunner
} from "../ui";

export function GroupPage() {
  const { groupId = "" } = useParams<{ groupId?: string }>();
  const group = client.useQuery("group", groupId);
  if (group === undefined) return <Loading />;
  if (group === null) {
    return (
      <Page title="Not your group chat">
        <p className="text-stone-400">This record book is for members only. Ask the group for an invite with "@receipts setup".</p>
      </Page>
    );
  }
  return <GroupBook group={group} />;
}

function GroupBook({ group }: { group: Group }) {
  const auth = useAuth();
  const [renaming, setRenaming] = useState(false);
  const me = `u:${auth.userId}`;

  return (
    <Page
      eyebrow={`${group.members.length} member${group.members.length === 1 ? "" : "s"} · ${group.role}`}
      title={renaming ? <RenameForm group={group} onDone={() => setRenaming(false)} /> : group.name}
      actions={renaming ? null : <Button tone="ghost" onClick={() => setRenaming(true)}>Rename</Button>}
    >
      {group.nominations.length > 0 ? (
        <Section title="Pending nominations" count={group.nominations.length} hint="Not on the record until the author accepts">
          <SlipGrid
            cards={group.nominations}
            empty=""
            footer={(card) => (card.subjectRef === me ? <NominationButtons card={card} /> : null)}
          />
        </Section>
      ) : null}

      <Section title="🔥 Due soon" count={group.dueSoon.length}>
        <SlipGrid cards={group.dueSoon} empty="Nothing due in the next 30 days." />
      </Section>

      {group.blitz ? <BlitzBoard group={group} blitz={group.blitz} /> : null}

      <Section title="🏆 Standings" hint="Take Score rewards correct takes by heat">
        <Standings group={group} />
      </Section>

      <Section title="Pending" count={group.pending.length}>
        <SlipGrid cards={group.pending} empty='Nothing pending. Text "@receipts #take ..." in the group chat.' />
      </Section>

      <Section title="Recently settled" count={group.recentlySettled.length}>
        <SlipGrid cards={group.recentlySettled} empty="Nothing settled yet." />
      </Section>

      <Section title="Members" count={group.members.length} hint='Invite more with "@receipts setup" in the chat'>
        <ul className="flex flex-wrap gap-2">
          {group.members.map((member) => (
            <li key={member.userId}>
              <Link
                className="flex items-center gap-2 rounded-full border border-stone-800 bg-stone-900 py-1 pl-1 pr-3 text-sm text-stone-200 hover:border-amber-400"
                to={profilePath(group.id, `u:${member.userId}`)}
              >
                {member.avatarUrl ? (
                  <img alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" src={member.avatarUrl} />
                ) : (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-700 text-xs">{member.name.slice(0, 1)}</span>
                )}
                {member.name}
                {member.isMe ? <span className="text-stone-500">(you)</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </Page>
  );
}

function Standings({ group }: { group: Group }) {
  if (group.standings.length === 0) {
    return <Empty>No takes yet. Standings appear once someone makes a take.</Empty>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-stone-800">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="bg-stone-900 font-mono text-xs uppercase tracking-widest text-stone-500">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 text-right">Score</th>
            <th className="px-3 py-2 text-right">Right</th>
            <th className="px-3 py-2 text-right">Wrong</th>
            <th className="px-3 py-2 text-right">Pending</th>
            <th className="px-3 py-2 text-right">Accuracy</th>
            <th className="px-3 py-2 text-right">Avg heat</th>
          </tr>
        </thead>
        <tbody>
          {group.standings.map((standing, index) => (
            <tr className="border-t border-stone-800 text-stone-200" key={standing.subjectRef}>
              <td className="px-3 py-2 font-mono text-stone-500">{index + 1}</td>
              <td className="px-3 py-2 font-bold">
                <Link className="hover:text-amber-300" to={profilePath(group.id, standing.subjectRef)}>
                  {crownedName(standing.name, group.blitz?.crown.includes(standing.subjectRef) ?? false)}
                </Link>
              </td>
              <td className="px-3 py-2 text-right font-mono text-lg font-black text-amber-300">{standing.takeScore}</td>
              <td className="px-3 py-2 text-right font-mono">{standing.right}</td>
              <td className="px-3 py-2 text-right font-mono">{standing.wrong}</td>
              <td className="px-3 py-2 text-right font-mono">{standing.pending}</td>
              <td className="px-3 py-2 text-right font-mono">{formatPercent(standing.accuracy)}</td>
              <td className="px-3 py-2 text-right font-mono">{formatHeat(standing.averageHeat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Blitz = NonNullable<Group["blitz"]>;

function formatWhen(instant: number): string {
  return new Date(instant).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function blitzHint(blitz: Blitz): string {
  switch (blitz.phase) {
    case "live":
      return `Ends ${formatWhen(blitz.endsAt)} · due today or tomorrow: 4 pts · due before the anointing: 2 pts`;
    case "provisional":
      return `The 👑 is anointed ${formatWhen(blitz.anointAt)} · wrong takes keep half`;
    case "final":
      return `The 👑 was anointed ${formatWhen(blitz.anointAt)}`;
  }
}

function BlitzBoard({ group, blitz }: { group: Group; blitz: Blitz }) {
  return (
    <Section title="⚡ Take Blitz" hint={blitzHint(blitz)}>
      {blitz.board.length === 0 ? (
        <Empty>
          {blitz.phase === "live"
            ? 'No blitz takes yet. Text "@receipts the Giants win tonight" in the group chat.'
            : "Nobody made a blitz take."}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border border-stone-800">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <thead className="bg-stone-900 font-mono text-xs uppercase tracking-widest text-stone-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2 text-right">Points</th>
                <th className="px-3 py-2 text-right">Banked</th>
                <th className="px-3 py-2 text-right">On the tab</th>
                <th className="px-3 py-2 text-right">Takes</th>
              </tr>
            </thead>
            <tbody>
              {blitz.board.map((standing, index) => (
                <tr className="border-t border-stone-800 text-stone-200" key={standing.subjectRef}>
                  <td className="px-3 py-2 font-mono text-stone-500">{index + 1}</td>
                  <td className="px-3 py-2 font-bold">
                    <Link className="hover:text-amber-300" to={profilePath(group.id, standing.subjectRef)}>
                      {crownedName(standing.name, blitz.crown.includes(standing.subjectRef))}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-lg font-black text-amber-300">{standing.total}</td>
                  <td className="px-3 py-2 text-right font-mono">{standing.banked}</td>
                  <td className="px-3 py-2 text-right font-mono">{standing.tab}</td>
                  <td className="px-3 py-2 text-right font-mono">{standing.takes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function NominationButtons({ card }: { card: Pick<Card, "id" | "subjectName"> }) {
  const respond = client.useMutation("respondToNomination");
  const { busy, error, run } = useRunner();
  return (
    <div>
      <p className="mb-2 text-sm text-stone-700">Put your name on it?</p>
      <div className="flex gap-2">
        <Button tone="good" disabled={busy} onClick={() => void run(() => respond(card.id, true))}>
          Accept
        </Button>
        <Button tone="bad" disabled={busy} onClick={() => void run(() => respond(card.id, false))}>
          Reject
        </Button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function RenameForm({ group, onDone }: { group: Group; onDone: () => void }) {
  const rename = client.useMutation("renameGroup");
  const [name, setName] = useState(group.name);
  const { busy, error, run } = useRunner();

  async function onSubmit(event: Event) {
    event.preventDefault();
    if ((await run(() => rename(group.id, name))).ok) onDone();
  }

  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void onSubmit(event)}>
      <input
        className="min-w-0 rounded-md border border-stone-700 bg-stone-900 px-3 py-1 text-3xl font-black text-stone-50 outline-none focus:border-amber-400"
        maxLength={60}
        value={name}
        onInput={(event) => setName(event.currentTarget.value)}
      />
      <Button disabled={busy} type="submit">
        Save
      </Button>
      <Button tone="ghost" onClick={onDone}>
        Cancel
      </Button>
      <ErrorText error={error} />
    </form>
  );
}
