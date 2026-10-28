import assert from "node:assert/strict";
import test from "node:test";
import { databaseConfig } from "../src/config.ts";

test("runtime database configuration", async (t) => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await t.test("Neon URLs explicitly require certificate and hostname verification", () => {
    process.env.DATABASE_URL = "postgresql://test:test@ep-example-pooler.region.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    process.env.DATABASE_URL_UNPOOLED = "postgresql://test:test@ep-example.region.aws.neon.tech/neondb?sslmode=disable";
    const config = databaseConfig();
    assert.equal(new URL(config.databaseUrl).searchParams.get("sslmode"), "verify-full");
    assert.equal(new URL(config.databaseUrlUnpooled).searchParams.get("sslmode"), "verify-full");
    assert.equal(new URL(config.databaseUrl).searchParams.get("channel_binding"), "require");
  });

  await t.test("local connections retain their explicit transport settings", () => {
    const url = "postgresql://localhost:5432/dungeons";
    process.env.DATABASE_URL = url;
    process.env.DATABASE_URL_UNPOOLED = url;
    assert.deepEqual(databaseConfig(), { databaseUrl: url, databaseUrlUnpooled: url });
  });

  await t.test("both generated database variables are required", () => {
    delete process.env.DATABASE_URL_UNPOOLED;
    assert.throws(() => databaseConfig(), /DATABASE_URL_UNPOOLED/);
  });

  await t.test("invalid URLs fail without echoing their contents", () => {
    process.env.DATABASE_URL = "invalid-sensitive-value";
    process.env.DATABASE_URL_UNPOOLED = "postgresql://localhost/dungeons";
    assert.throws(() => databaseConfig(), {
      message: "Database configuration must contain valid PostgreSQL URLs",
    });
    process.env.DATABASE_URL = "https://example.com";
    assert.throws(() => databaseConfig(), {
      message: "Database configuration must use the postgres or postgresql protocol",
    });
  });
});
