import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encode } from "@auth/core/jwt";
import { Pool } from "pg";
import { ScriptedProvider } from "../src/agents/provider.ts";
import { AdventureEngine } from "../src/engine.ts";
import { createApp } from "../src/server/app.ts";
import { authSettingsFromEnv } from "../src/server/auth.ts";
import { RunManager } from "../src/server/runs.ts";
import { fixed } from "./support.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const SECRET = "test-secret-that-is-long-enough-0123456789";
const GOOGLE_ID = "test-client.apps.googleusercontent.com";

const fullEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AUTH_SECRET: SECRET,
  AUTH_GOOGLE_ID: GOOGLE_ID,
  AUTH_GOOGLE_SECRET: "test-google-secret",
  ALLOWED_EMAILS: "Owner@Example.com, second@example.com",
  AUTH_URL: "http://localhost:4317",
  ...overrides,
});

test("sign-in settings come all together or not at all", () => {
  assert.equal(authSettingsFromEnv({}), null);
  assert.equal(authSettingsFromEnv({ AUTH_URL: " " }), null);
  const settings = authSettingsFromEnv(fullEnv({ AUTH_URL: "https://dungeons.example.com" }));
  assert.equal(settings?.origin.origin, "https://dungeons.example.com");
  assert.equal(settings?.googleId, GOOGLE_ID);
  assert.throws(() => authSettingsFromEnv({ AUTH_SECRET: SECRET, AUTH_URL: "http://localhost:4317" }),
    /set AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, ALLOWED_EMAILS as well, or remove AUTH_SECRET, AUTH_URL/);
  assert.throws(() => authSettingsFromEnv(fullEnv({ AUTH_URL: "http://localhost:4317/app" })), /AUTH_URL must be the director's origin/);
  assert.throws(() => authSettingsFromEnv(fullEnv({ AUTH_URL: "ftp://localhost" })), /AUTH_URL must be the director's origin/);
  assert.throws(() => authSettingsFromEnv(fullEnv({ AUTH_SECRET: "short" })), /at least 32 characters/);
  assert.throws(() => authSettingsFromEnv(fullEnv({ ALLOWED_EMAILS: " , " })), /at least one email/);
});

test("the server refuses to start with a login it cannot keep", () => {
  // Every case fails before the database is opened; DATABASE_URL is deliberately absent.
  const start = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(import.meta.dirname, "../src/server/main.ts")], {
    env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 20_000,
  });
  const cases: [Record<string, string>, RegExp][] = [
    [{ AUTH_SECRET: SECRET }, /only partly set up: set AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, ALLOWED_EMAILS, AUTH_URL as well/],
    [{ HOST: "0.0.0.0" }, /has no login, so it only listens on this machine/],
    [{ ...fullEnv(), HOST: "0.0.0.0" } as Record<string, string>, /needs an https AUTH_URL/],
    [{ ...fullEnv(), PORT: "5000" } as Record<string, string>, /AUTH_URL points at port 4317 but the director listens on 5000/],
  ];
  for (const [env, message] of cases) {
    const result = start(env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
});

/** A browser's cookies for one site. */
class CookieJar {
  readonly cookies = new Map<string, string>();

  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key, raw] = attribute.split("=").map((part) => part.trim());
        return (key!.toLowerCase() === "max-age" && Number(raw) <= 0) || (key!.toLowerCase() === "expires" && Date.parse(raw!) <= Date.now());
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** Google's side of sign-in: discovery, keys, and a token endpoint whose code names the account. */
function simulatedGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = (claims: Record<string, unknown>) => {
    const input = `${part({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${part(claims)}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;
  };
  const tokenRequests: URLSearchParams[] = [];
  const googleFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === "https://accounts.google.com/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256", "plain"],
      });
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    if (url.href === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(await new Response(init?.body ?? null).text());
      tokenRequests.push(form);
      const [email, verified] = (form.get("code") ?? "").split("|");
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        access_token: "test-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
        id_token: idToken({
          iss: "https://accounts.google.com", aud: GOOGLE_ID, sub: `google-${email}`, email, email_verified: verified === "yes",
          name: "Test Person", iat: now, exp: now + 3600,
        }),
      });
    }
    return new Response("Not found", { status: 404 });
  };
  return { googleFetch, tokenRequests };
}

test("Google sign-in for the web director", {
  skip: connectionString ? false : "Set TEST_DATABASE_URL to run real PostgreSQL integration tests",
}, async (t) => {
  assert.ok(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const engine = new AdventureEngine(connectionString, { schema, roll: fixed(10) });
  const runs = new RunManager({
    engine,
    providerFor: async () => new ScriptedProvider([]),
    rehearsalEngine: () => new AdventureEngine(connectionString, { schema }),
    settings: { narrate: false },
  });
  const staticDir = await mkdtemp(path.join(tmpdir(), "dungeons-web-"));
  const google = simulatedGoogle();
  let handler: RequestListener = (_request, response) => response.end();
  const server = createServer((request, response) => handler(request, response));
  try {
    await engine.initialize();
    await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>UI</title>");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const env: NodeJS.ProcessEnv = { ...fullEnv({ AUTH_URL: origin }), OPENROUTER_API_KEY: "test-key" };
    const settings = authSettingsFromEnv(env)!;
    const signedInApp = createApp({
      engine, runs, env, allowedHosts: ["localhost"], staticDir, pollMs: 50, auth: { ...settings, fetch: google.googleFetch },
    });
    handler = signedInApp;

    const send = async (method: string, route: string, options: { jar?: CookieJar; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
      const headers: Record<string, string> = { ...options.headers };
      if (options.jar?.cookies.size) headers.cookie = options.jar.header();
      let body: string | undefined;
      if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
      }
      if (options.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(options.form).toString();
      }
      const response = await fetch(`${origin}${route}`, { method, headers, redirect: "manual", ...(body === undefined ? {} : { body }) });
      options.jar?.take(response);
      return response;
    };
    /** Signs in as an account through the simulated Google and returns the browser's cookies. */
    const signIn = async (email: string, verified = true) => {
      const jar = new CookieJar();
      const { csrfToken } = await (await send("GET", "/api/auth/csrf", { jar })).json() as { csrfToken: string };
      const started = await send("POST", "/api/auth/signin/google", {
        jar, form: { csrfToken, callbackUrl: `${origin}/worlds/somewhere` }, headers: { "X-Auth-Return-Redirect": "1" },
      });
      assert.equal(started.status, 200);
      const authorize = new URL((await started.json() as { url: string }).url);
      const back = await send("GET", `/api/auth/callback/google?code=${encodeURIComponent(`${email}|${verified ? "yes" : "no"}`)}`, { jar });
      return { jar, authorize, back };
    };

    await t.test("without a session, only health, the session check, and the app's files answer", async () => {
      assert.equal((await send("GET", "/api/health")).status, 200);
      assert.deepEqual(await (await send("GET", "/api/session")).json(), { login: true, email: null, allowed: false });
      assert.equal((await send("GET", "/")).status, 200);
      for (const route of ["/api/worlds", "/api/adventures", "/api/models", "/api/drafts", "/api/worlds/anything/stream"]) {
        const response = await send("GET", route);
        assert.equal(response.status, 401, route);
        assert.deepEqual(await response.json(), { error: "Sign in first.", code: "SIGN_IN" });
      }
      assert.equal((await send("POST", "/api/worlds", { json: { id: "nope", adventureId: "aqueduct" } })).status, 401);
    });

    await t.test("an allowed account signs in through Google and can use the director", async () => {
      const { jar, authorize, back } = await signIn("owner@example.com");
      assert.equal(`${authorize.origin}${authorize.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
      assert.equal(authorize.searchParams.get("client_id"), GOOGLE_ID);
      assert.equal(authorize.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/google`);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.match(authorize.searchParams.get("scope") ?? "", /openid/);
      const exchange = google.tokenRequests.at(-1)!;
      assert.equal(exchange.get("redirect_uri"), `${origin}/api/auth/callback/google`);
      assert.ok(exchange.get("code_verifier"), "the token exchange proves the PKCE verifier");

      assert.equal(back.status, 302);
      assert.equal(back.headers.get("location"), `${origin}/worlds/somewhere`);
      assert.ok(jar.cookies.has("authjs.session-token"));
      assert.deepEqual(await (await send("GET", "/api/session", { jar })).json(), { login: true, email: "owner@example.com", allowed: true });
      assert.equal((await send("GET", "/api/worlds", { jar })).status, 200);
      const created = await send("POST", "/api/worlds", { jar, json: { id: "signed-in", adventureId: "aqueduct" } });
      assert.equal(created.status, 201);

      // The existing same-site guard still holds for a signed-in browser.
      const crossSite = await send("POST", "/api/worlds/signed-in/mute", {
        jar, json: { characterIds: ["mira"], muted: true }, headers: { origin: "https://evil.example" },
      });
      assert.equal(crossSite.status, 403);

      // Taking an email off the list takes effect at the next request.
      env.ALLOWED_EMAILS = "second@example.com";
      try {
        const refused = await send("GET", "/api/worlds", { jar });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json() as { code: string }).code, "NOT_ALLOWED");
        assert.deepEqual(await (await send("GET", "/api/session", { jar })).json(), { login: true, email: "owner@example.com", allowed: false });
      } finally {
        env.ALLOWED_EMAILS = fullEnv().ALLOWED_EMAILS!;
      }

      const { csrfToken } = await (await send("GET", "/api/auth/csrf", { jar })).json() as { csrfToken: string };
      const out = await send("POST", "/api/auth/signout", { jar, form: { csrfToken }, headers: { "X-Auth-Return-Redirect": "1" } });
      assert.equal(out.status, 200);
      assert.ok(!jar.cookies.has("authjs.session-token"), "signing out clears the session cookie");
      assert.equal((await send("GET", "/api/worlds", { jar })).status, 401);
    });

    await t.test("accounts off the list, or with an unverified email, are turned away", async () => {
      for (const [email, verified] of [["stranger@example.com", true], ["second@example.com", false]] as const) {
        const { jar, back } = await signIn(email, verified);
        assert.equal(back.status, 302);
        assert.equal(back.headers.get("location"), `${origin}/?error=AccessDenied`);
        assert.ok(!jar.cookies.has("authjs.session-token"), email);
        assert.equal((await send("GET", "/api/worlds", { jar })).status, 401);
      }
    });

    await t.test("sign-in posts need Auth.js's CSRF token, and forged sessions are refused", async () => {
      const jar = new CookieJar();
      const forged = await send("POST", "/api/auth/signin/google", { jar, form: { callbackUrl: origin }, headers: { "X-Auth-Return-Redirect": "1" } });
      assert.ok(!(await forged.json() as { url: string }).url.startsWith("https://accounts.google.com"), "no CSRF token, no trip to Google");

      const token = async (secret: string) => encode({ token: { email: "owner@example.com", name: "Owner" }, secret, salt: "authjs.session-token" });
      const genuine = new CookieJar();
      genuine.cookies.set("authjs.session-token", await token(SECRET));
      assert.equal((await send("GET", "/api/worlds", { jar: genuine })).status, 200);
      const other = new CookieJar();
      other.cookies.set("authjs.session-token", await token("another-secret-that-is-long-enough-987654"));
      assert.equal((await send("GET", "/api/worlds", { jar: other })).status, 401);
    });

    await t.test("with no login configured, there is no sign-in and nothing to sign into", async () => {
      handler = createApp({ engine, runs, env: { OPENROUTER_API_KEY: "test-key" }, allowedHosts: ["localhost"], staticDir });
      try {
        assert.deepEqual(await (await send("GET", "/api/session")).json(), { login: false, email: null, allowed: false });
        assert.equal((await send("GET", "/api/worlds")).status, 200);
        assert.equal((await send("GET", "/api/auth/csrf")).status, 404);
      } finally {
        handler = signedInApp;
      }
    });
  } finally {
    await runs.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await engine.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
