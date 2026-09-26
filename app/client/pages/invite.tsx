import { Link, useNavigate, useParams } from "lakebed/client";
import { client } from "../api";
import { Button, ErrorText, Loading, Page, useRunner } from "../ui";

export function InvitePage() {
  const { token = "" } = useParams<{ token?: string }>();
  const invite = client.useQuery("invite", token);
  const redeem = client.useMutation("redeemInvite");
  const navigate = useNavigate();
  const { busy, error, run } = useRunner();

  if (invite === undefined) return <Loading />;
  if (invite === null) {
    return (
      <Page eyebrow="Invite" title="That link doesn't work">
        <p className="text-stone-400">Ask the group chat for a fresh one with "@receipts setup" or "@receipts join".</p>
      </Page>
    );
  }

  const isJoin = invite.kind === "join";
  const title = isJoin ? "Claim your texts" : `Join ${invite.groupName}`;

  async function accept() {
    const result = await run(() => redeem(token));
    if (result.ok) navigate(`/g/${result.value.groupId}`);
  }

  return (
    <Page eyebrow={invite.groupName} title={title}>
      <div className="max-w-lg rounded-md bg-stone-100 p-6 text-stone-900 shadow-2xl shadow-black/50">
        {invite.status === "expired" ? (
          <p>
            This link expired. Send {isJoin ? '"@receipts join"' : '"@receipts setup"'} in the group chat for a new one.
          </p>
        ) : invite.status === "used" ? (
          <p>
            These texts have already been linked to an account. Send "@receipts join" from your own phone for your own link.
            {invite.alreadyMember ? (
              <>
                {" "}
                <Link className="font-bold underline" to={`/g/${invite.groupId}`}>
                  Open the record book
                </Link>
              </>
            ) : null}
          </p>
        ) : (
          <>
            {isJoin ? (
              <p className="mb-4">
                This links the iMessage sender <span className="font-mono font-bold">{invite.handleHint}</span> in{" "}
                <span className="font-bold">{invite.groupName}</span> to your account. Their receipts become yours. Only continue if
                that's your number or email.
              </p>
            ) : (
              <p className="mb-4">
                You're invited to the record book for <span className="font-bold">{invite.groupName}</span>.
                {invite.alreadyMember ? " You're already in." : ""}
              </p>
            )}
            <Button disabled={busy} onClick={() => void accept()}>
              {isJoin ? "That's me, link it" : invite.alreadyMember ? "Open the record book" : "Join the group"}
            </Button>
            <ErrorText error={error} />
          </>
        )}
      </div>
    </Page>
  );
}
