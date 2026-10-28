import type { WorldState } from "./types.ts";

export function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function credits(cost: number | null): string {
  if (cost === null) return "unreported";
  return cost === 0 ? "0" : cost < 0.0001 ? "<0.0001" : cost.toFixed(4);
}

export function nameOf(state: WorldState, id: string): string {
  return state.characters.find((entry) => entry.id === id)?.name
    ?? state.locations.find((entry) => entry.id === id)?.name
    ?? state.items.find((entry) => entry.id === id)?.name
    ?? state.challenges.find((entry) => entry.id === id)?.name
    ?? state.threats?.find((entry) => entry.id === id)?.name
    ?? state.endings?.find((entry) => entry.id === id)?.name
    ?? id;
}

/** The server's event line without its clock stamp, which the feed shows separately. */
export function unstamped(line: string): string {
  return line.replace(/^\[[^\]]*\]\s*/, "");
}

export function ago(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** A suggested ID for a new world: the base, then -2, -3, … until unused. */
export function freshId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}
