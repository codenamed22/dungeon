import { parseEnv } from "@neon/env";
import neonConfig from "../neon.ts";
import { AdventureEngine } from "./engine.ts";
import type { EngineOptions } from "./engine.ts";

export function databaseConfig() {
  const config = parseEnv(neonConfig, ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]).postgres;
  return {
    databaseUrl: verifiedNeonUrl(config.databaseUrl),
    databaseUrlUnpooled: verifiedNeonUrl(config.databaseUrlUnpooled),
  };
}

function verifiedNeonUrl(value: string): string {
  if (!URL.canParse(value)) throw new Error("Database configuration must contain valid PostgreSQL URLs");
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Database configuration must use the postgres or postgresql protocol");
  }
  if (url.hostname.endsWith(".neon.tech")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

/** Migrates through the direct connection, then returns an engine on the pooled one. */
export async function openConfiguredEngine(options: EngineOptions = {}): Promise<AdventureEngine> {
  const config = databaseConfig();
  const migrationEngine = new AdventureEngine(
    config.databaseUrlUnpooled,
    options.schema === undefined ? {} : { schema: options.schema },
  );
  try {
    await migrationEngine.initialize();
  } finally {
    await migrationEngine.close();
  }
  return new AdventureEngine(config.databaseUrl, options);
}
