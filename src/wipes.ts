import type { EventData } from "./model.ts";

// Which events the director wiped. A wipe takes the story back to before
// `fromSequence`: that event and every one up to the wipe are wiped, except
// edits and deletions made meanwhile to lines before `fromSequence`, which
// stay. Browser-safe, for the web feed as well as the server.

interface Line {
  sequence: number;
  data: EventData;
}

/** Whether an event in a wipe's range outlives it: an edit or deletion of an earlier line. */
export function survivesWipe(data: EventData, fromSequence: number): boolean {
  return data.type === "retraction" && data.targetSequence < fromSequence;
}

/**
 * Each wiped event among `events`, mapped to the wipe that took it back first.
 * `events` must run up to the newest event, so that every wipe covering one of
 * them is among them; a world's whole history, or its latest page, does.
 */
export function wipedBy(events: readonly Line[]): Map<number, number> {
  const wiped = new Map<number, number>();
  for (const wipe of events) {
    if (wipe.data.type !== "wiped") continue;
    const from = wipe.data.fromSequence;
    for (const event of events) {
      if (event.sequence < from || event.sequence >= wipe.sequence || wiped.has(event.sequence) || survivesWipe(event.data, from)) continue;
      wiped.set(event.sequence, wipe.sequence);
    }
  }
  return wiped;
}

/** `events` without the wiped ones: the story as it stands. */
export function liveEvents<E extends Line>(events: readonly E[]): E[] {
  const wiped = wipedBy(events);
  return wiped.size === 0 ? [...events] : events.filter((event) => !wiped.has(event.sequence));
}
