import { Link, SignInWithGoogle } from "lakebed/client";
import { client } from "../api";
import { Empty, Loading, Page, Section } from "../ui";
import { ChatDemo, HowItWorks } from "./guide";

export function Landing({ reason }: { reason?: string }) {
  return (
    <div>
      <div className="mb-16 grid gap-10 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-amber-400">The record book for your group chat</p>
          <h1 className="mb-5 text-5xl font-black leading-none tracking-tight text-stone-50 sm:text-6xl">
            Keep the receipts.
          </h1>
          <p className="mb-8 max-w-md text-lg text-stone-400">
            Takes, promises, and bets from your iMessage group, locked in when they were bold and resurfaced when they come due.
          </p>
          {reason ? <p className="mb-4 text-sm text-amber-300">{reason}</p> : null}
          <div className="flex flex-wrap items-center gap-5">
            <SignInWithGoogle className="rounded-md bg-amber-400 px-5 py-2.5 font-bold text-stone-950 hover:bg-amber-300" />
            <a className="text-sm font-bold text-stone-300 underline-offset-4 hover:text-stone-100 hover:underline" href="#get-started">
              How it works ↓
            </a>
          </div>
        </div>
        <ChatDemo />
      </div>
      <HowItWorks />
    </div>
  );
}

export function HomePage() {
  const home = client.useQuery("home");
  if (!home) return <Loading />;
  return (
    <Page eyebrow={`Hey ${home.displayName}`} title="Your groups">
      <Section title="Record books" count={home.groups.length}>
        {home.groups.length === 0 ? (
          <Empty>
            No groups yet. Add the Receipts account to an iMessage group, send "@receipts setup", and open the invite link it
            replies with.{" "}
            <Link className="underline hover:text-stone-300" to="/how-it-works">
              How it works
            </Link>
          </Empty>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {home.groups.map((group) => (
              <li key={group.id}>
                <Link
                  className="flex items-center justify-between rounded-md border border-stone-800 bg-stone-900 px-4 py-4 hover:border-amber-400"
                  to={`/g/${group.id}`}
                >
                  <span className="text-lg font-bold text-stone-100">{group.name}</span>
                  <span className="font-mono text-xs uppercase tracking-widest text-stone-500">{group.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
