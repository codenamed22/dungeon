import { Auth, customFetch } from "@auth/core";
import type { AuthConfig } from "@auth/core";
import Google from "@auth/core/providers/google";

// Google sign-in for the web director, set up as in Traveller: Auth.js with the
// Google provider, JWT sessions in a cookie, and an email allowlist. Only
// allowed accounts may sign in at all, since every page shows private memories
// and spends model credit, and each request checks the list again so removing
// an email takes effect at once.

/** The variables that turn sign-in on; all or none of them must be set. */
export const AUTH_VARS = ["AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "ALLOWED_EMAILS", "AUTH_URL"] as const;

/** Where Auth.js answers: the sign-in, callback, session, and sign-out routes. */
export const AUTH_BASE_PATH = "/api/auth";

export interface AuthSettings {
  /** The director's own origin, which Google returns to (AUTH_URL). */
  origin: URL;
  secret: string;
  googleId: string;
  googleSecret: string;
  /** How Auth.js reaches Google; tests simulate it. */
  fetch?: typeof fetch;
}

export class AuthConfigError extends Error {}

export function allowedEmails(env: NodeJS.ProcessEnv): string[] {
  return (env.ALLOWED_EMAILS ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function allowedEmail(email: string | null | undefined, env: NodeJS.ProcessEnv): boolean {
  return Boolean(email && allowedEmails(env).includes(email.toLowerCase()));
}

/** Sign-in settings from the environment: null when none are set, and an error when only some are. */
export function authSettingsFromEnv(env: NodeJS.ProcessEnv): AuthSettings | null {
  const value = (name: (typeof AUTH_VARS)[number]) => env[name]?.trim() ?? "";
  const set = AUTH_VARS.filter((name) => value(name));
  if (set.length === 0) return null;
  const missing = AUTH_VARS.filter((name) => !value(name));
  if (missing.length > 0) {
    throw new AuthConfigError(`Google sign-in is only partly set up: set ${missing.join(", ")} as well, or remove ${set.join(", ")} to run without a login on this machine only`);
  }
  const url = URL.canParse(value("AUTH_URL")) ? new URL(value("AUTH_URL")) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new AuthConfigError("AUTH_URL must be the director's origin, such as http://localhost:4317 or https://dungeons.example.com, with no path");
  }
  if (value("AUTH_SECRET").length < 32) {
    throw new AuthConfigError("AUTH_SECRET must be at least 32 characters; generate one with: openssl rand -base64 33");
  }
  if (allowedEmails(env).length === 0) throw new AuthConfigError("ALLOWED_EMAILS must list at least one email address");
  return { origin: new URL(url.origin), secret: value("AUTH_SECRET"), googleId: value("AUTH_GOOGLE_ID"), googleSecret: value("AUTH_GOOGLE_SECRET") };
}

export interface DirectorAuth {
  readonly origin: URL;
  /** Answers a request under /api/auth: sign-in, the Google callback, the session, and sign-out. */
  handle(request: Request): Promise<Response>;
  /** The signed-in account for a request's cookies, or null. */
  session(cookie: string | undefined): Promise<{ email: string } | null>;
}

export function createAuth(settings: AuthSettings, env: NodeJS.ProcessEnv): DirectorAuth {
  const config: AuthConfig = {
    providers: [Google({
      clientId: settings.googleId,
      clientSecret: settings.googleSecret,
      ...(settings.fetch ? { [customFetch]: settings.fetch } : {}),
    })],
    basePath: AUTH_BASE_PATH,
    secret: settings.secret,
    trustHost: true,
    session: { strategy: "jwt" },
    // Refusals come back to the app, which explains them on its sign-in screen.
    pages: { signIn: "/", error: "/" },
    callbacks: {
      signIn: ({ user, profile }) => profile?.email_verified === true && allowedEmail(user.email, env),
    },
    logger: {
      // A refused account, or a stale or forged session cookie, is expected: it
      // just means signed out. Anything else is worth a line in the log.
      error: (error) => {
        if (error.name === "AccessDenied" || error.name === "JWTSessionError") return;
        // Auth.js wraps what went wrong in the callback as the error's cause.
        const cause = (error.cause as { err?: unknown } | undefined)?.err;
        console.error(`[auth] ${error.name}${cause instanceof Error ? `: ${cause.message}` : ""}`);
      },
      warn: (code) => console.warn(`[auth] ${code}`),
      debug: () => {},
    },
  };

  return {
    origin: settings.origin,
    handle: (request) => Auth(request, config),
    async session(cookie) {
      if (!cookie) return null;
      const response = await Auth(new Request(new URL(`${AUTH_BASE_PATH}/session`, settings.origin), { headers: { cookie } }), config);
      if (!response.ok) return null;
      const data = await response.json().catch(() => null) as { user?: { email?: unknown } } | null;
      const email = data?.user?.email;
      return typeof email === "string" && email ? { email: email.toLowerCase() } : null;
    },
  };
}
