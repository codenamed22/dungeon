import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Monitor, Moon, Plus, Sun, LayoutGrid } from "lucide-react";
import { api, errorText, SIGNED_OUT_EVENT, signOut } from "./api.ts";
import type { SessionInfo } from "./api.ts";
import { Creator } from "./pages/Creator.tsx";
import { Home } from "./pages/Home.tsx";
import { NewWorld } from "./pages/NewWorld.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { WorldPage } from "./pages/WorldPage.tsx";
import { linkProps, useRoute } from "./router.ts";
import { useStored } from "./ui/hooks.ts";

type Theme = "system" | "light" | "dark";
const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useStored<Theme>("dungeons.theme", "system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const ThemeIcon = THEME_ICON[theme];
  const worldsActive = route.page === "home" || route.page === "world";
  const { session, error } = useSession();
  const signedIn = session !== null && (!session.login || (session.email !== null && session.allowed));

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" {...linkProps("/")}>dungeons<span>.</span></a>
        {signedIn && <nav className="app-nav" aria-label="Main">
          <a className={`nav-link ${worldsActive ? "active" : ""}`} {...linkProps("/")} aria-current={worldsActive ? "page" : undefined}>
            <LayoutGrid size={17} /><span>Worlds</span>
          </a>
          <a className={`nav-link ${route.page === "new" || route.page === "create" ? "active" : ""}`} {...linkProps("/new")}>
            <Plus size={17} /><span>New world</span>
          </a>
        </nav>}
        <div className="header-actions">
          <button type="button" className="icon-button" onClick={() => setTheme(NEXT_THEME[theme])}
            title={`Theme: ${theme}. Click for ${NEXT_THEME[theme]}.`} aria-label={`Theme: ${theme}`}>
            <ThemeIcon size={18} />
          </button>
          {signedIn && session.login && session.email && (
            <button type="button" className="account-button" onClick={() => void signOut()} title={`Signed in as ${session.email}`}
              aria-label={`Sign out ${session.email}`}>
              <span className="avatar" aria-hidden="true">{session.email[0]!.toUpperCase()}</span><span>Sign out</span>
            </button>
          )}
        </div>
      </header>
      {session === null
        ? <main className="page">{error ? <p className="error">{error}</p> : <p className="muted"><LoaderCircle size={15} className="spin" /> Loading…</p>}</main>
        : !signedIn
          ? <SignIn session={session} />
          : <>
            {route.page === "world" && <WorldPage key={route.worldId} worldId={route.worldId} />}
            {route.page === "create" && <Creator key={route.draftId} draftId={route.draftId} />}
            {route.page === "new" && <NewWorld />}
            {route.page === "home" && <Home />}
          </>}
    </div>
  );
}

/** Who is signed in, checked on load and again whenever the server turns a request away for want of a session. */
function useSession(): { session: SessionInfo | null; error: string | null } {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(() => {
    api.session().then((next) => {
      setSession(next);
      setError(null);
    }, (problem: unknown) => setError(errorText(problem)));
  }, []);
  useEffect(() => {
    check();
    window.addEventListener(SIGNED_OUT_EVENT, check);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, check);
  }, [check]);
  return { session, error };
}
