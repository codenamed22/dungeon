import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the lockfile names only the public npm registry, so Vercel can install from it", () => {
  const lock = JSON.parse(readFileSync(path.join(import.meta.dirname, "../package-lock.json"), "utf8")) as { packages: Record<string, { resolved?: string }> };
  const elsewhere = Object.entries(lock.packages)
    .filter(([, entry]) => entry.resolved && !entry.resolved.startsWith("https://registry.npmjs.org/"))
    .map(([key]) => key);
  assert.deepEqual(elsewhere, [], "Run npm run lock:public after installing through a private registry");
});
