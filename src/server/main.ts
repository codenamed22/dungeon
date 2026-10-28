import { createServer } from "node:http";
import path from "node:path";
import { REHEARSAL_ROLL } from "../adventures/rehearsal.ts";
import { providerForSetup } from "../agents/setup.ts";
import { databaseConfig, openConfiguredEngine } from "../config.ts";
import { AdventureEngine } from "../engine.ts";
import { createApp } from "./app.ts";
import { allowedEmails, AuthConfigError, authSettingsFromEnv } from "./auth.ts";
import type { AuthSettings } from "./auth.ts";
import { RunManager } from "./runs.ts";

// Starts the web director. Without Google sign-in it has no login, so it binds
// only to a loopback address and answers only to local host names. With sign-in
// it answers to its AUTH_URL as well, and may listen beyond this machine when
// that address is https.

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadAuth(): AuthSettings | null {
  try {
    return authSettingsFromEnv(process.env);
  } catch (error) {
    if (error instanceof AuthConfigError) fail(error.message);
    throw error;
  }
}

const auth = loadAuth();
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("PORT must be a port number");
if (!LOOPBACK.has(host)) {
  if (!auth) fail(`The web director has no login, so it only listens on this machine; HOST=${host} is not a loopback address. Set up Google sign-in to listen beyond it.`);
  if (auth.origin.protocol !== "https:") fail(`Listening beyond this machine (HOST=${host}) needs an https AUTH_URL, so the sign-in cookie never travels unencrypted.`);
}
const authPort = auth ? Number(auth.origin.port || (auth.origin.protocol === "https:" ? 443 : 80)) : port;
if (auth && LOOPBACK.has(auth.origin.hostname.replace(/^\[|\]$/g, "")) && authPort !== port) {
  fail(`AUTH_URL points at port ${authPort} but the director listens on ${port}; Google would send you back to the wrong port.`);
}

const schema = process.env.DUNGEONS_SCHEMA?.trim() || undefined;
const engineOptions = schema === undefined ? {} : { schema };
const engine = await openConfiguredEngine(engineOptions);
const { databaseUrl } = databaseConfig();
const runs = new RunManager({
  engine,
  providerFor: (models) => providerForSetup(models, process.env),
  rehearsalEngine: () => new AdventureEngine(databaseUrl, { ...engineOptions, roll: () => REHEARSAL_ROLL }),
});
const app = createApp({
  engine,
  runs,
  env: process.env,
  allowedHosts: ["localhost", "127.0.0.1", "::1", ...(auth ? [auth.origin.hostname.replace(/^\[|\]$/g, "")] : [])],
  staticDir: path.resolve(import.meta.dirname, "../../web/dist"),
  auth,
});
const server = createServer(app);

server.listen(port, host, () => {
  const database = new URL(databaseUrl);
  console.log(`Dungeons web director: ${auth ? auth.origin.origin : `http://localhost:${port}`}`);
  const accounts = allowedEmails(process.env).length;
  console.log(auth ? `Login: Google (${accounts} allowed account${accounts === 1 ? "" : "s"})` : "Login: off (this machine only)");
  console.log(`Database: ${database.hostname}${database.pathname}${schema ? `, schema ${schema}` : ""}`);
  console.log(process.env.OPENROUTER_API_KEY?.trim() ? "OpenRouter key: set" : "OpenRouter key: not set (only the scripted opening can play)");
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping: pausing runs; an unfinished turn will not commit. Press Ctrl+C again to quit now.");
  await runs.close();
  server.closeAllConnections();
  server.close();
  await engine.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
