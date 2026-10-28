import { useState } from "react";
import { LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { errorText, signIn, signOut } from "../api.ts";
import type { SessionInfo } from "../api.ts";
import { EmptyState } from "../ui/controls.tsx";

// The director shows private memories and spends model credit, so with Google
// sign-in on it asks for an allowed account first, then returns to the same page.

const ERRORS: Record<string, string> = {
  AccessDenied: "That Google account isn't allowed here. Use another account, or ask for it to be added to ALLOWED_EMAILS.",
  Configuration: "Sign-in isn't set up correctly. The server log says why.",
};

export function SignIn({ session }: { session: SessionInfo }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const here = new URL(window.location.href);
  const refusal = here.searchParams.get("error");
  here.searchParams.delete("error");
  const refused = session.email !== null && !session.allowed;

  async function go(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(errorText(error));
      setBusy(false);
    }
  }

  const message = problem ?? (refusal ? ERRORS[refusal] ?? "Sign-in didn't finish. Try again." : null);
  return (
    <main className="page sign-in">
      <div className="card">
        <EmptyState icon={<LockKeyhole size={22} />} title="Sign in to Dungeons">
          <p>Only allowed Google accounts can open the director.</p>
          {refused && <p className="error">{session.email} isn't allowed here.</p>}
          {message && <p className="error" role="alert">{message}</p>}
          <div className="sign-in-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void go(() => signIn(here.href, refused || refusal !== null))}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <UserRound size={16} />}
              {refused || refusal ? "Use another Google account" : "Sign in with Google"}
            </button>
            {session.email && <button type="button" className="text-button" disabled={busy} onClick={() => void go(signOut)}>Sign out</button>}
          </div>
        </EmptyState>
      </div>
    </main>
  );
}
