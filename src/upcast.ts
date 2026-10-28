import { EVENT_FORMAT, eventSchema, parseStored } from "./model.ts";
import type { AdventureEvent } from "./model.ts";

/** Speech time given to worlds created before speech existed. */
export const LEGACY_SPEECH_SECONDS = 10;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Non-numbers pass through unchanged so that validation still rejects them.
function toSeconds(minutes: unknown): unknown {
  return typeof minutes === "number" ? minutes * 60 : minutes;
}

function renameMinutes(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const { minutes, ...rest } = entry;
  return { ...rest, seconds: toSeconds(minutes) };
}

function upcastV1Seed(seed: unknown): unknown {
  if (!isObject(seed)) return seed;
  return {
    ...seed,
    speechSeconds: LEGACY_SPEECH_SECONDS,
    locations: Array.isArray(seed.locations)
      ? seed.locations.map((location) => (
        isObject(location) && Array.isArray(location.routes)
          ? { ...location, routes: location.routes.map(renameMinutes) }
          : location
      ))
      : seed.locations,
    challenges: Array.isArray(seed.challenges) ? seed.challenges.map(renameMinutes) : seed.challenges,
  };
}

function upcastV1Data(data: unknown): unknown {
  if (!isObject(data)) return data;
  switch (data.type) {
    case "world_created":
      return { ...data, seed: upcastV1Seed(data.seed) };
    case "character_moved":
    case "time_advanced":
      return renameMinutes(data);
    case "check_resolved":
      return { ...(renameMinutes(data) as JsonObject), effects: { unlockedRoutes: [], grantedItems: [] } };
    default:
      return data;
  }
}

/**
 * Converts a stored event of any known format to the current format. Phase 1
 * (format 1) events have no `v` field and measure time in minutes.
 */
export function upcastEvent(raw: unknown): unknown {
  if (!isObject(raw) || raw.v !== undefined) return raw;
  const { elapsedMinutes, data, ...rest } = raw;
  return {
    ...rest,
    v: EVENT_FORMAT,
    source: isObject(data) && data.type === "world_created" ? "director" : "character",
    elapsedSeconds: toSeconds(elapsedMinutes),
    data: upcastV1Data(data),
  };
}

export function parseStoredEvent(raw: unknown): AdventureEvent {
  return parseStored(eventSchema, upcastEvent(raw));
}
