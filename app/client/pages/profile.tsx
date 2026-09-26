import { Link, useNavigate, useParams } from "lakebed/client";
import type { ComponentChildren } from "preact";
import { crownedName } from "../../shared/format";
import { client, type Profile } from "../api";
import { Button, ErrorText, formatHeat, formatPercent, Loading, Page, profilePath, Section, Slip, SlipGrid, useRunner } from "../ui";
import { NominationButtons } from "./group";

export function ProfilePage() {
  const { groupId = "", subjectRef = "" } = useParams<{ groupId?: string; subjectRef?: string }>();
  const profile = client.useQuery("profile", groupId, subjectRef);
  if (profile === undefined) return <Loading />;
  if (profile === null) {
    return (
      <Page title="Nobody here">
        <p className="text-stone-400">
          No receipts under that name. <Link className="underline" to={`/g/${groupId}`}>Back to the record book</Link>
        </p>
      </Page>
    );
  }
  return <ProfileView profile={profile} />;
}

function Stat({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div className="rounded-md border border-stone-800 bg-stone-900 px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-widest text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-stone-50">{children}</p>
    </div>
  );
}

function ProfileView({ profile }: { profile: Profile }) {
  const { standing } = profile;
  return (
    <Page
      eyebrow={
        <Link className="hover:text-amber-200" to={`/g/${profile.groupId}`}>
          ← {profile.groupName}
        </Link>
      }
      title={
        <>
          {crownedName(profile.name, profile.crowned)}
          {profile.isMe ? <span className="ml-3 align-middle font-mono text-sm font-normal text-stone-500">(you)</span> : null}
        </>
      }
      actions={profile.claimable ? <ClaimButton profile={profile} /> : null}
    >
      <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Take Score">
          <span className="text-amber-300">{standing.takeScore}</span>
        </Stat>
        <Stat label="Record">
          {standing.right}–{standing.wrong}
        </Stat>
        <Stat label="Accuracy">{formatPercent(standing.accuracy)}</Stat>
        <Stat label="Avg heat">{formatHeat(standing.averageHeat)}</Stat>
        <Stat label="Pending">{standing.pending}</Stat>
      </div>

      {profile.hottestCorrect ? (
        <Section title="🔥 Hottest correct take">
          <div className="max-w-xl">
            <Slip card={profile.hottestCorrect} />
          </div>
        </Section>
      ) : null}

      {profile.nominations.length > 0 ? (
        <Section title="Awaiting their signature" count={profile.nominations.length}>
          <SlipGrid
            cards={profile.nominations}
            empty=""
            footer={(card) => (profile.isMe ? <NominationButtons card={card} /> : null)}
          />
        </Section>
      ) : null}

      <Section title="Current takes" count={profile.currentTakes.length}>
        <SlipGrid cards={profile.currentTakes} empty="No open takes." />
      </Section>
      <Section title="Recently settled" count={profile.recent.length}>
        <SlipGrid cards={profile.recent} empty="Nothing settled yet." />
      </Section>
      <Section title="Promises" count={profile.promises.length}>
        <SlipGrid cards={profile.promises} empty="No promises." />
      </Section>
      <Section title="Bets" count={profile.bets.length}>
        <SlipGrid cards={profile.bets} empty="No bets." />
      </Section>
      <Section title="Conditionals" count={profile.conditionals.length}>
        <SlipGrid cards={profile.conditionals} empty="No conditionals." />
      </Section>
    </Page>
  );
}

function ClaimButton({ profile }: { profile: Profile }) {
  const claim = client.useMutation("claimName");
  const navigate = useNavigate();
  const { busy, error, run } = useRunner();

  async function onClaim() {
    if (!window.confirm(`Claim every receipt about "${profile.name}" in ${profile.groupName} as yours?`)) return;
    const result = await run(() => claim(profile.groupId, profile.subjectRef));
    if (result.ok) navigate(profilePath(profile.groupId, result.value.subjectRef), { replace: true });
  }

  return (
    <div className="text-right">
      <Button disabled={busy} onClick={() => void onClaim()}>
        This is me
      </Button>
      <ErrorText error={error} />
    </div>
  );
}
