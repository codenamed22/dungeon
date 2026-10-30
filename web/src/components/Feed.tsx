import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Eraser, GitBranch, Pencil, Trash2 } from "lucide-react";
import { survivesWipe, wipedBy } from "../../../src/wipes.ts";
import { api, errorText } from "../api.ts";
import { nameOf, unstamped } from "../format.ts";
import { navigate, worldPath } from "../router.ts";
import type { EventView, WorldView } from "../types.ts";
import { SheetDialog } from "../ui/Dialog.tsx";
import { NARROW, useMedia, useStored } from "../ui/hooks.ts";

const PRIVATE = new Set(["discovery", "insight", "belief_noted", "goal_set"]);
const HIDDEN = new Set(["threat_armed", "threat_disarmed", "track_changed", "threshold_reached"]);
/** Lines left out unless "Show hidden" is on: characters' notes and goals, and what the engine does out of sight. */
const BACKSTAGE = new Set(["belief_noted", "goal_set", ...HIDDEN]);
/** The most words each kind of line may have, matching the engine's limits. */
const LINE_LIMITS: Record<string, number> = { narration: 1000, utterance: 700, introduced: 2000 };

/**
 * Lines the director can delete: words, notes, and goal changes, so an
 * introduced event that changed routes is undone by wiping instead. `latest`
 * is whether a goal change is that goal's latest, the only one that can go.
 */
function deletable(event: EventView, latest: boolean): boolean {
  if (event.type === "narration" || event.type === "utterance" || event.type === "belief_noted") return true;
  if (event.type === "goal_set") return latest;
  return event.data.type === "introduced" && event.data.lockedRoutes.length + event.data.unlockedRoutes.length === 0;
}

/** What the director did to a line since: its latest words, or its deletion, with any correction given. */
interface Change {
  words?: string;
  editedBy?: number;
  deletedBy?: number;
  note?: string;
}

type Mode = "edit" | "delete" | "wipe" | "branch";

/** What wiping from a line takes: lines #from to #last, `count` of them, as edits of earlier lines stay. */
interface WipePlan {
  from: number;
  last: number;
  count: number;
}

/**
 * The story as it happens. The director's view shows everything, marking
 * what was private, hidden, out of the story, edited, deleted, or wiped; a
 * character's view shows only what that character perceived, as its agent
 * remembers it, with the director's edits. Either leaves out notes, goals,
 * and hidden lines until "Show hidden" is on.
 */
export function Feed({ worldId, view, events, viewer, toolbar }: {
  worldId: string;
  view: WorldView;
  events: EventView[];
  viewer: string | null;
  /** Controls shown before "Show hidden" in the bar above the lines. */
  toolbar: ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  const narrow = useMedia(NARROW);
  const [follow, setFollow] = useState(true);
  const [backstage, setBackstage] = useStored<"show" | "hide">("dungeons.feedHidden", "hide");
  /** The line whose actions are open, and which one; null on a phone's menu before one is chosen. */
  const [open, setOpen] = useState<{ sequence: number; mode: Mode | null } | null>(null);

  const wiped = useMemo(() => wipedBy(events), [events]);
  const changes = useMemo(() => {
    const found = new Map<number, Change>();
    for (const event of events) {
      if (event.data.type !== "retraction" || wiped.has(event.sequence)) continue;
      const { targetSequence, replacement, text } = event.data;
      const change = found.get(targetSequence) ?? {};
      if (replacement !== undefined) Object.assign(change, { words: replacement, editedBy: event.sequence });
      else Object.assign(change, { deletedBy: event.sequence }, text === undefined ? {} : { note: text });
      found.set(targetSequence, change);
    }
    return found;
  }, [events, wiped]);
  // A branch may start after the last event of a turn, and a wipe at the first event of one.
  const turnEnds = useMemo(() => {
    const ends = new Map<number, number>();
    let last = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (events[index + 1]?.requestId !== event.requestId) last = event.sequence;
      ends.set(event.sequence, last);
    }
    return ends;
  }, [events]);
  const wipeStarts = useMemo(() => {
    const ranges = events.flatMap((event) => (event.data.type === "wiped" ? [{ from: event.data.fromSequence, at: event.sequence }] : []));
    const starts = new Map<number, number | null>();
    let first: EventView | undefined;
    events.forEach((event, index) => {
      if (events[index - 1]?.requestId !== event.requestId) first = event;
      const from = first!.sequence;
      // A wipe can't start at a wipe, or at an edit, which would outlive it, or within an earlier wipe.
      const allowed = from > 1 && first!.type !== "wiped" && first!.type !== "retraction"
        && !ranges.some((range) => range.from <= from && from < range.at);
      starts.set(event.sequence, allowed ? from : null);
    });
    return starts;
  }, [events]);
  // Only a goal's latest change can be deleted.
  const latestGoalChanges = useMemo(() => {
    const latest = new Map<string, number>();
    for (const event of events) {
      if (event.data.type === "goal_set" && !wiped.has(event.sequence) && changes.get(event.sequence)?.deletedBy === undefined) {
        latest.set(`${event.data.actorId} ${event.data.goalId}`, event.sequence);
      }
    }
    return new Set(latest.values());
  }, [events, wiped, changes]);
  const wipePlan = (from: number): WipePlan => ({
    from,
    last: events.at(-1)!.sequence,
    count: events.filter((event) => event.sequence >= from && !wiped.has(event.sequence) && !survivesWipe(event.data, from)).length,
  });
  const perceived = viewer === null
    ? events
    : events.filter((event) => event.perceivers.includes(viewer) && changes.get(event.sequence)?.deletedBy === undefined && !wiped.has(event.sequence));
  const hidden = perceived.filter((event) => BACKSTAGE.has(event.type)).length;
  const shown = backstage === "show" ? perceived : perceived.filter((event) => !BACKSTAGE.has(event.type));
  // A turn's last shown line offers its branch, which still starts after the turn's last event, shown or not.
  const branchAt = new Map<number, number>();
  if (viewer === null) {
    shown.forEach((event, index) => {
      const end = turnEnds.get(event.sequence)!;
      if (end > 1 && turnEnds.get(shown[index + 1]?.sequence ?? 0) !== end) branchAt.set(event.sequence, end);
    });
  }

  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, follow]);

  return (
    <>
      <div className="feed-toolbar">
        {toolbar}
        <label className="inline feed-hidden" title="Characters' notes and goals, and what the engine does out of sight: threats set in motion or stopped, and hidden tracks moving">
          <input type="checkbox" checked={backstage === "show"} onChange={(change) => setBackstage(change.target.checked ? "show" : "hide")} />
          Show hidden{hidden > 0 && ` (${hidden})`}
        </label>
      </div>
      <div className="feed" onScroll={(event) => {
        const box = event.currentTarget;
        setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 80);
      }}>
        {shown.length === 0 && <p className="muted">{hidden > 0 ? "Only hidden lines so far." : "Nothing yet."}</p>}
        {shown.map((event) => {
          const change = changes.get(event.sequence);
          const wipedAt = wiped.get(event.sequence);
          const live = viewer === null && change?.deletedBy === undefined && wipedAt === undefined;
          const wipeFrom = viewer === null && wipedAt === undefined ? wipeStarts.get(event.sequence) ?? null : null;
          const isOpen = open?.sequence === event.sequence;
          return (
            <EventItem
              key={event.sequence}
              event={event}
              view={view}
              viewer={viewer}
              change={change}
              wipedBy={wipedAt}
              canEdit={live && event.type in LINE_LIMITS}
              canDelete={live && deletable(event, latestGoalChanges.has(event.sequence))}
              wipe={wipeFrom === null ? null : isOpen ? wipePlan(wipeFrom) : { from: wipeFrom, last: 0, count: 0 }}
              branchAt={branchAt.get(event.sequence) ?? null}
              mode={isOpen ? open.mode : undefined}
              onOpen={(mode) => setOpen({ sequence: event.sequence, mode })}
              onClose={() => setOpen(null)}
              worldId={worldId}
              narrow={narrow}
            />
          );
        })}
        <div ref={end} />
      </div>
    </>
  );
}

function EventItem({ event, view, viewer, change, wipedBy, canEdit, canDelete, wipe, branchAt, mode, onOpen, onClose, worldId, narrow }: {
  event: EventView;
  view: WorldView;
  viewer: string | null;
  change: Change | undefined;
  /** The wipe that took this line back, if one did. */
  wipedBy: number | undefined;
  canEdit: boolean;
  canDelete: boolean;
  /** Where wiping from this line starts, the first line of its turn; null if it can't. Counted only while its actions are open. */
  wipe: WipePlan | null;
  /** The last event of this line's turn, which a branch from it keeps; null if it offers no branch. */
  branchAt: number | null;
  /** Undefined while closed; null for the phone's menu. */
  mode: Mode | null | undefined;
  onOpen(mode: Mode | null): void;
  onClose(): void;
  worldId: string;
  narrow: boolean;
}) {
  const [original, setOriginal] = useState(false);
  const state = view.world;
  const data = event.data;
  const name = (id: string) => (id === viewer ? "You" : nameOf(state, id));
  const deleted = change?.deletedBy !== undefined;
  const text = "text" in data && typeof data.text === "string" ? data.text : null;
  const words = change?.words ?? text;
  const tags: string[] = [];
  if (PRIVATE.has(event.type)) tags.push("private");
  if (HIDDEN.has(event.type)) tags.push("hidden");
  if (event.type === "steering") tags.push("out of story");
  if (change?.editedBy !== undefined && viewer === null) tags.push("edited");
  if (deleted) tags.push(change.note === undefined ? `deleted by #${change.deletedBy}` : `retconned by #${change.deletedBy}`);
  if (wipedBy !== undefined) tags.push(`wiped by #${wipedBy}`);

  let body;
  let kind = "line";
  if (data.type === "utterance") {
    kind = "speech";
    body = (
      <>
        <div className="speaker">
          <strong>{name(data.actorId)}</strong>
          {data.addresseeId && <span className="muted"> to {name(data.addresseeId)}</span>}
          <span className="muted small"> · {nameOf(state, data.locationId)}</span>
        </div>
        <div className="words">{words}</div>
      </>
    );
  } else if (data.type === "narration") {
    kind = "narration";
    body = <div className="words">{words}</div>;
  } else {
    if (event.type === "threat_triggered") kind = "threat";
    else if (event.type === "story_ended") kind = "ending";
    else if (event.type === "steering" || event.type === "introduced" || event.type === "retraction" || event.type === "wiped") kind = "director";
    // Someone the director brought in or sent away; the story's own entrances and exits read as plain lines.
    else if ((event.type === "character_entered" || event.type === "character_exited") && event.source === "director") kind = "director";
    else if (PRIVATE.has(event.type) || HIDDEN.has(event.type)) kind = "aside";
    // The director's wording, even in a character's view: it names everyone instead of saying "you".
    const line = unstamped(event.line);
    body = <div>{text !== null && words !== text ? line.replace(text, words!) : line}</div>;
  }
  const actions = canEdit || canDelete || wipe !== null || branchAt !== null;
  const panel = mode !== undefined && (
    <EventActions worldId={worldId} view={view} event={event} words={words ?? ""} mode={mode}
      canEdit={canEdit} canDelete={canDelete} wipe={wipe} branchAt={branchAt} onMode={onOpen} done={onClose} />
  );

  return (
    <article className={`event ${kind} ${deleted ? "retracted" : ""} ${wipedBy !== undefined ? "wiped" : ""}`}>
      <div className="meta">
        <span className="seq" title={event.requestId}>#{event.sequence}</span>
        <span>{event.clock}</span>
        {tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
        {viewer === null && event.perceivers.length > 0 && (
          <span className="muted small" title="Who perceived this">seen by {event.perceivers.map((id) => nameOf(state, id)).join(", ")}</span>
        )}
        {viewer === null && change?.editedBy !== undefined && (
          <button type="button" className="link small" onClick={() => setOriginal(!original)}>{original ? "hide original" : "original"}</button>
        )}
        {actions && (narrow ? (
          <button type="button" className="link small event-menu" aria-label={`Actions for #${event.sequence}`} onClick={() => onOpen(null)}>…</button>
        ) : (
          <span className="line-actions">
            {canEdit && (
              <button type="button" className={`icon-button ${mode === "edit" ? "active" : ""}`} aria-label={`Edit #${event.sequence}`} title="Edit this line"
                onClick={() => (mode === "edit" ? onClose() : onOpen("edit"))}><Pencil size={14} /></button>
            )}
            {canDelete && (
              <button type="button" className={`icon-button ${mode === "delete" ? "active" : ""}`} aria-label={`Delete #${event.sequence}`} title="Delete this line"
                onClick={() => (mode === "delete" ? onClose() : onOpen("delete"))}><Trash2 size={14} /></button>
            )}
            {wipe !== null && (
              <button type="button" className={`icon-button ${mode === "wipe" ? "active" : ""}`} aria-label={`Wipe from #${event.sequence}`}
                title="Wipe from here: take the story back to before this turn" onClick={() => (mode === "wipe" ? onClose() : onOpen("wipe"))}><Eraser size={14} /></button>
            )}
            {branchAt !== null && (
              <button type="button" className={`icon-button ${mode === "branch" ? "active" : ""}`} aria-label={`Branch at #${event.sequence}`}
                title="Branch a new world from here" onClick={() => (mode === "branch" ? onClose() : onOpen("branch"))}><GitBranch size={14} /></button>
            )}
          </span>
        ))}
      </div>
      {body}
      {original && text !== null && <div className="original small">Originally: {text}</div>}
      {!narrow && panel}
      {narrow && panel && (
        <SheetDialog name="event" title={`Event #${event.sequence}`} onClose={onClose}>{panel}</SheetDialog>
      )}
    </article>
  );
}

function EventActions({ worldId, view, event, words, mode, canEdit, canDelete, wipe, branchAt, onMode, done }: {
  worldId: string;
  view: WorldView;
  event: EventView;
  /** The line's words now, which an edit starts from. */
  words: string;
  mode: Mode | null;
  canEdit: boolean;
  canDelete: boolean;
  wipe: WipePlan | null;
  branchAt: number | null;
  onMode(mode: Mode): void;
  done(): void;
}) {
  const [text, setText] = useState(words);
  const [note, setNote] = useState("");
  const at = branchAt ?? event.sequence;
  const [branchId, setBranchId] = useState(`${worldId}-at-${at}`);
  const [branchName, setBranchName] = useState(`${view.world.name} (from #${at})`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const thought = thoughtDeletion(view, event);

  async function act(submit: FormEvent, work: () => Promise<unknown>) {
    submit.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await work();
      done();
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  }

  async function branch(submit: FormEvent) {
    submit.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.branch(worldId, at, branchId.trim(), branchName.trim());
      navigate(worldPath(created.world.id));
    } catch (problem) {
      setError(errorText(problem));
      setBusy(false);
    }
  }

  return (
    <div className="event-actions">
      {mode === null && (
        <div className="row wrap">
          {canEdit && <button type="button" onClick={() => onMode("edit")}><Pencil size={15} />Edit</button>}
          {canDelete && <button type="button" onClick={() => onMode("delete")}><Trash2 size={15} />Delete</button>}
          {wipe !== null && <button type="button" onClick={() => onMode("wipe")}><Eraser size={15} />Wipe from here</button>}
          {branchAt !== null && <button type="button" onClick={() => onMode("branch")}><GitBranch size={15} />Branch</button>}
        </div>
      )}
      {mode === "edit" && (
        <form onSubmit={(submit) => void act(submit, () => api.editLine(worldId, event.sequence, text.trim()))} className="stack">
          <label className="field">
            Edit #{event.sequence}. Those who heard it remember these words instead; what they already said or concluded stays.
            <textarea rows={3} value={text} maxLength={LINE_LIMITS[event.type]} onChange={(change) => setText(change.target.value)} autoFocus />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !text.trim() || text.trim() === words}>Save</button>
            <button type="button" onClick={done}>Cancel</button>
          </div>
        </form>
      )}
      {mode === "delete" && thought !== null && (
        <form onSubmit={(submit) => void act(submit, () => api.deleteLine(worldId, event.sequence))} className="stack">
          <span className="small">Delete #{event.sequence}? {thought} It stays in this log, crossed out.</span>
          <div className="row">
            <button type="submit" className="danger" disabled={busy}>Delete</button>
            <button type="button" onClick={done}>Cancel</button>
          </div>
        </form>
      )}
      {mode === "delete" && thought === null && (
        <form onSubmit={(submit) => void act(submit, () => api.deleteLine(worldId, event.sequence, note.trim() || undefined))} className="stack">
          <span className="small">Delete #{event.sequence}? Those who heard it forget it. It stays in this log, crossed out.</span>
          <label className="field">
            Tell them what really happened (optional)
            <input value={note} maxLength={1000} onChange={(change) => setNote(change.target.value)} placeholder="e.g. The door is still locked; nobody opened it." />
          </label>
          <div className="row">
            <button type="submit" className="danger" disabled={busy}>Delete line</button>
            <button type="button" onClick={done}>Cancel</button>
          </div>
        </form>
      )}
      {mode === "wipe" && wipe !== null && (
        <form onSubmit={(submit) => void act(submit, () => api.wipe(worldId, wipe.from))} className="stack">
          <span className="small">
            Wipe {wipe.from === wipe.last ? `#${wipe.from}` : `#${wipe.from}–#${wipe.last}`} ({lines(wipe.count)})?
            {wipe.from < event.sequence && ` This turn starts at #${wipe.from}.`} The world goes back to how it was before #{wipe.from},
            and nobody remembers what came after. Your edits to earlier lines stay. The lines stay here, faded; branch from one to play them again.
          </span>
          <div className="row">
            <button type="submit" className="danger" disabled={busy || wipe.count === 0}>Wipe {lines(wipe.count)}</button>
            <button type="button" onClick={done}>Cancel</button>
          </div>
        </form>
      )}
      {mode === "branch" && (
        <form onSubmit={(submit) => void branch(submit)} className="stack">
          <span className="small">
            Branch: a new world with this history up to #{at}.{at > event.sequence && ` This turn ends at #${at}, on a hidden line.`} This world stays as it is.
          </span>
          <div className="row wrap">
            <input value={branchId} onChange={(change) => setBranchId(change.target.value)} aria-label="New world ID" />
            <input value={branchName} onChange={(change) => setBranchName(change.target.value)} aria-label="New world name" className="grow" />
            <button type="submit" disabled={busy || !branchId.trim()}>Branch</button>
          </div>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function lines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

/** What deleting a note or goal change does, said of whose it is; null for any other line. */
function thoughtDeletion(view: WorldView, event: EventView): string | null {
  const data = event.data;
  if (data.type === "belief_noted") return `${nameOf(view.world, data.actorId)} forgets this note.`;
  if (data.type !== "goal_set") return null;
  const name = nameOf(view.world, data.actorId);
  return data.status === "adopted" ? `${name} forgets this goal.` : `${name} forgets this, and pursues the goal again.`;
}
