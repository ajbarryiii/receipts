import { canAccessApp, ErrorBoundary, Link, retryAuth, Route, Router, Routes, SignInWithGoogle, signOut, useAuth, useLocation } from "lakebed/client";
import type { ComponentChildren } from "preact";
import { GroupPage } from "./pages/group";
import { GuidePage } from "./pages/guide";
import { HomePage, Landing } from "./pages/home";
import { InvitePage } from "./pages/invite";
import { ProfilePage } from "./pages/profile";
import { ReceiptPage } from "./pages/receipt";
import { Button, Loading } from "./ui";

function Shell({ children }: { children: ComponentChildren }) {
  const auth = useAuth();
  return (
    <main className="min-h-screen bg-stone-950 text-stone-200">
      <nav className="border-b border-stone-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
          <Link className="font-mono text-sm font-bold uppercase tracking-widest text-stone-100" to="/">
            🧾 Receipts
          </Link>
          <div className="flex min-w-0 items-center gap-4">
            <Link className="whitespace-nowrap text-sm text-stone-400 hover:text-stone-100" to="/how-it-works">
              How it works
            </Link>
            {auth.isSignedIn ? (
              <div className="flex min-w-0 items-center gap-3">
                {auth.picture ? <img alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" src={auth.picture} /> : null}
                <span className="hidden truncate text-sm text-stone-400 sm:inline">{auth.displayName}</span>
                <button className="text-sm text-stone-500 hover:text-stone-200" type="button" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </nav>
      <div className="mx-auto max-w-5xl px-5 py-10">{children}</div>
    </main>
  );
}

function SignedOut() {
  const auth = useAuth();
  const { pathname } = useLocation();
  if (auth.error) {
    return (
      <div className="max-w-md">
        <p className="mb-4 text-rose-400" role="alert">
          {auth.error}
        </p>
        <div className="flex gap-3">
          <Button tone="ghost" onClick={() => void retryAuth()}>
            Retry
          </Button>
          <SignInWithGoogle className="rounded-md bg-amber-400 px-3 py-1.5 text-sm font-bold text-stone-950" />
        </div>
      </div>
    );
  }
  const reason = pathname.startsWith("/join/")
    ? "Sign in to accept your invite. You'll come right back here."
    : pathname === "/"
      ? undefined
      : "Sign in to open this record book.";
  return <Landing reason={reason} />;
}

function Pages() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/join/:token" element={<InvitePage />} />
        <Route path="/g/:groupId" element={<GroupPage />} />
        <Route path="/g/:groupId/r/:number" element={<ReceiptPage />} />
        <Route path="/g/:groupId/p/:subjectRef" element={<ProfilePage />} />
        <Route
          path="*"
          element={
            <p className="text-stone-400">
              Not found. <Link className="underline" to="/">Home</Link>
            </p>
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export function App() {
  const auth = useAuth();
  return (
    <Router>
      <Shell>
        <Routes>
          {/* Public: the instructions don't need an account. */}
          <Route path="/how-it-works" element={<GuidePage />} />
          <Route path="*" element={auth.isLoading ? <Loading label="Checking session" /> : canAccessApp() && auth.isSignedIn ? <Pages /> : <SignedOut />} />
        </Routes>
      </Shell>
    </Router>
  );
}
