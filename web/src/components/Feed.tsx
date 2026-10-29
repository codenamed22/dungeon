import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { GitBranch, Pencil, Trash2 } from "lucide-react";
import { api, errorText } from "../api.ts";
import { nameOf, unstamped } from "../format.ts";
import { navigate, worldPath } from "../router.ts";
import type { EventView, WorldView } from "../types.ts";
import { SheetDialog } from "../ui/Dialog.tsx";
import { NARROW, useMedia } from "../ui/hooks.ts";

const PRIVATE = new Set(["discovery", "belief_noted", "goal_set"]);
const HIDDEN = new Set(["threat_armed", "threat_disarmed"]);
/** The most words each kind of line may have, matching the engine's limits. */
const LINE_LIMITS: Record<string, number> = { narration: 1000, utterance: 700, introduced: 1000 };

/** Lines the director can delete: words only, so an introduced event that changed routes is undone by branching instead. */
function deletable(event: EventView): boolean {
  if (event.type === "narration" || event.type === "utterance") return true;
  return event.data.type === "introduced" && event.data.lockedRoutes.length + event.data.unlockedRoutes.length === 0;
}

/** What the director did to a line since: its latest words, or its deletion, with any correction given. */
interface Change {
  words?: string;
  editedBy?: number;
  deletedBy?: number;
  note?: string;
}

type Mode = "edit" | "delete" | "branch";

/**
 * The story as it happens. The director's view shows everything, marking
 * what was private, hidden, out of the story, edited, or deleted; a
 * character's view shows only what that character perceived, as its agent
 * remembers it, with the director's edits.
 */
export function Feed({ worldId, view, events, viewer }: {
  worldId: string;
  view: WorldView;
  events: EventView[];
  viewer: string | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const narrow = useMedia(NARROW);
  const [follow, setFollow] = useState(true);
  /** The line whose actions are open, and which one; null on a phone's menu before one is chosen. */
  const [open, setOpen] = useState<{ sequence: number; mode: Mode | null } | null>(null);

  const changes = useMemo(() => {
    const found = new Map<number, Change>();
    for (const event of events) {
      if (event.data.type !== "retraction") continue;
      const { targetSequence, replacement, text } = event.data;
      const change = found.get(targetSequence) ?? {};
      if (replacement !== undefined) Object.assign(change, { words: replacement, editedBy: event.sequence });
      else Object.assign(change, { deletedBy: event.sequence }, text === undefined ? {} : { note: text });
      found.set(targetSequence, change);
    }
    return found;
  }, [events]);
  // A branch may start after any event that ends its request.
  const turnEnds = useMemo(() => new Set(events.filter((event, index) => events[index + 1]?.requestId !== event.requestId)
    .map((event) => event.sequence)), [events]);
  const shown = viewer === null
    ? events
    : events.filter((event) => event.perceivers.includes(viewer) && changes.get(event.sequence)?.deletedBy === undefined);

  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, follow]);

  return (
    <div className="feed" onScroll={(event) => {
      const box = event.currentTarget;
      setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 80);
    }}>
      {shown.length === 0 && <p className="muted">Nothing yet.</p>}
      {shown.map((event) => {
        const change = changes.get(event.sequence);
        const live = viewer === null && change?.deletedBy === undefined;
        return (
          <EventItem
            key={event.sequence}
            event={event}
            view={view}
            viewer={viewer}
            change={change}
            canEdit={live && event.type in LINE_LIMITS}
            canDelete={live && deletable(event)}
            canBranch={viewer === null && event.type !== "world_created" && turnEnds.has(event.sequence)}
            mode={open?.sequence === event.sequence ? open.mode : undefined}
            onOpen={(mode) => setOpen({ sequence: event.sequence, mode })}
            onClose={() => setOpen(null)}
            worldId={worldId}
            narrow={narrow}
          />
        );
      })}
      <div ref={end} />
    </div>
  );
}

function EventItem({ event, view, viewer, change, canEdit, canDelete, canBranch, mode, onOpen, onClose, worldId, narrow }: {
  event: EventView;
  view: WorldView;
  viewer: string | null;
  change: Change | undefined;
  canEdit: boolean;
  canDelete: boolean;
  canBranch: boolean;
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
    else if (event.type === "steering" || event.type === "introduced" || event.type === "retraction") kind = "director";
    // Someone the director brought in or sent away; the story's own entrances and exits read as plain lines.
    else if ((event.type === "character_entered" || event.type === "character_exited") && event.source === "director") kind = "director";
    else if (PRIVATE.has(event.type) || HIDDEN.has(event.type)) kind = "aside";
    // The director's wording, even in a character's view: it names everyone instead of saying "you".
    const line = unstamped(event.line);
    body = <div>{text !== null && words !== text ? line.replace(text, words!) : line}</div>;
  }
  const actions = canEdit || canDelete || canBranch;
  const panel = mode !== undefined && (
    <EventActions worldId={worldId} view={view} event={event} words={words ?? ""} mode={mode}
      canEdit={canEdit} canDelete={canDelete} canBranch={canBranch} onMode={onOpen} done={onClose} />
  );

  return (
    <article className={`event ${kind} ${deleted ? "retracted" : ""}`}>
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
          <button type="button" className="link small event-menu" aria-label={`Edit, delete, or branch at #${event.sequence}`} onClick={() => onOpen(null)}>…</button>
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
            {canBranch && (
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

function EventActions({ worldId, view, event, words, mode, canEdit, canDelete, canBranch, onMode, done }: {
  worldId: string;
  view: WorldView;
  event: EventView;
  /** The line's words now, which an edit starts from. */
  words: string;
  mode: Mode | null;
  canEdit: boolean;
  canDelete: boolean;
  canBranch: boolean;
  onMode(mode: Mode): void;
  done(): void;
}) {
  const [text, setText] = useState(words);
  const [note, setNote] = useState("");
  const [branchId, setBranchId] = useState(`${worldId}-at-${event.sequence}`);
  const [branchName, setBranchName] = useState(`${view.world.name} (from #${event.sequence})`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const created = await api.branch(worldId, event.sequence, branchId.trim(), branchName.trim());
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
          {canBranch && <button type="button" onClick={() => onMode("branch")}><GitBranch size={15} />Branch</button>}
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
      {mode === "delete" && (
        <form onSubmit={(submit) => void act(submit, () => api.deleteLine(worldId, event.sequence, note.trim() || undefined))} className="stack">
          <span className="small">Delete #{event.sequence}? Those who heard it forget it. It stays in this log, crossed out.</span>
          <label className="field">
            Tell them what really happened (optional)
            <input value={note} maxLength={500} onChange={(change) => setNote(change.target.value)} placeholder="e.g. The door is still locked; nobody opened it." />
          </label>
          <div className="row">
            <button type="submit" className="danger" disabled={busy}>Delete line</button>
            <button type="button" onClick={done}>Cancel</button>
          </div>
        </form>
      )}
      {mode === "branch" && (
        <form onSubmit={(submit) => void branch(submit)} className="stack">
          <span className="small">Branch: a new world with this history up to #{event.sequence}. This world stays as it is.</span>
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
