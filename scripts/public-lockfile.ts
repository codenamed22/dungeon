// Points every package in package-lock.json at the public npm registry, so a
// build machine such as Vercel can install them. npm on a machine that uses a
// private mirror records the mirror's URLs; it still downloads through its own
// registry afterwards, because npm swaps registry.npmjs.org for the configured
// registry (its replace-registry-host setting). Integrity hashes are unchanged.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PUBLIC = "https://registry.npmjs.org/";
const file = path.join(import.meta.dirname, "../package-lock.json");
const lock = JSON.parse(readFileSync(file, "utf8")) as { packages: Record<string, { resolved?: string }> };
let changed = 0;
for (const [key, entry] of Object.entries(lock.packages)) {
  if (!entry.resolved || entry.resolved.startsWith(PUBLIC) || !key.includes("node_modules/")) continue;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  entry.resolved = `${PUBLIC}${name}/-/${entry.resolved.slice(entry.resolved.lastIndexOf("/") + 1)}`;
  changed += 1;
}
writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
console.log(changed === 0 ? "package-lock.json already uses the public registry" : `Pointed ${changed} package(s) at ${PUBLIC}`);
