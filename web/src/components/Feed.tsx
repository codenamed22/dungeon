import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorText } from "../api.ts";
import { nameOf, unstamped } from "../format.ts";
import { navigate, worldPath } from "../router.ts";
import type { EventView, WorldView } from "../types.ts";
import { SheetDialog } from "../ui/Dialog.tsx";
import { NARROW, useMedia } from "../ui/hooks.ts";

const PRIVATE = new Set(["discovery", "belief_noted", "goal_set"]);
const HIDDEN = new Set(["threat_armed", "threat_disarmed"]);

function retractable(event: EventView): boolean {
  if (event.type === "narration" || event.type === "utterance") return true;
  return event.data.type === "introduced" && event.data.lockedRoutes.length + event.data.unlockedRoutes.length === 0;
}

/**
 * The story as it happens. The director's view shows everything, marking
 * what was private, hidden, or out of the story; a character's view shows only
 * what that character perceived, as its agent remembers it.
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
  const [open, setOpen] = useState<number | null>(null);

  const retracted = useMemo(() => new Map(events.flatMap((event) => (
    event.data.type === "retraction" ? [[event.data.targetSequence, event.sequence] as const] : []
  ))), [events]);
  // A branch may start after any event that ends its request.
  const turnEnds = useMemo(() => new Set(events.filter((event, index) => events[index + 1]?.requestId !== event.requestId)
    .map((event) => event.sequence)), [events]);
  const shown = viewer === null
    ? events
    : events.filter((event) => event.perceivers.includes(viewer) && !retracted.has(event.sequence));

  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, follow]);

  return (
    <div className="feed" onScroll={(event) => {
      const box = event.currentTarget;
      setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 80);
    }}>
      {shown.length === 0 && <p className="muted">Nothing yet.</p>}
      {shown.map((event) => (
        <EventItem
          key={event.sequence}
          event={event}
          view={view}
          viewer={viewer}
          retractedBy={retracted.get(event.sequence) ?? null}
          actions={viewer === null && event.type !== "world_created"}
          canRetcon={retractable(event) && !retracted.has(event.sequence)}
          canBranch={turnEnds.has(event.sequence)}
          open={open === event.sequence}
          onToggle={() => setOpen(open === event.sequence ? null : event.sequence)}
          worldId={worldId}
          narrow={narrow}
        />
      ))}
      <div ref={end} />
    </div>
  );
}

function EventItem({ event, view, viewer, retractedBy, actions, canRetcon, canBranch, open, onToggle, worldId, narrow }: {
  event: EventView;
  view: WorldView;
  viewer: string | null;
  retractedBy: number | null;
  actions: boolean;
  canRetcon: boolean;
  canBranch: boolean;
  open: boolean;
  onToggle(): void;
  worldId: string;
  narrow: boolean;
}) {
  const state = view.world;
  const data = event.data;
  const name = (id: string) => (id === viewer ? "You" : nameOf(state, id));
  const tags: string[] = [];
  if (PRIVATE.has(event.type)) tags.push("private");
  if (HIDDEN.has(event.type)) tags.push("hidden");
  if (event.type === "steering") tags.push("out of story");
  if (retractedBy !== null) tags.push(`retconned by #${retractedBy}`);

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
        <div className="words">{data.text}</div>
      </>
    );
  } else if (data.type === "narration") {
    kind = "narration";
    body = <div className="words">{data.text}</div>;
  } else {
    if (event.type === "threat_triggered") kind = "threat";
    else if (event.type === "story_ended") kind = "ending";
    else if (event.type === "steering" || event.type === "introduced" || event.type === "retraction") kind = "director";
    else if (PRIVATE.has(event.type) || HIDDEN.has(event.type)) kind = "aside";
    // The director's wording, even in a character's view: it names everyone instead of saying "you".
    body = <div>{unstamped(event.line)}</div>;
  }

  return (
    <article className={`event ${kind} ${retractedBy !== null ? "retracted" : ""}`}>
      <div className="meta">
        <span className="seq" title={event.requestId}>#{event.sequence}</span>
        <span>{event.clock}</span>
        {tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
        {viewer === null && event.perceivers.length > 0 && (
          <span className="muted small" title="Who perceived this">seen by {event.perceivers.map((id) => nameOf(state, id)).join(", ")}</span>
        )}
        {actions && (canRetcon || canBranch) && (
          <button type="button" className="link small event-menu" aria-label={`Retcon or branch at #${event.sequence}`} onClick={onToggle}>{open && !narrow ? "close" : "…"}</button>
        )}
      </div>
      {body}
      {open && !narrow && <EventActions worldId={worldId} view={view} event={event} canRetcon={canRetcon} canBranch={canBranch} done={onToggle} />}
      {open && narrow && (
        <SheetDialog name="event" title={`Event #${event.sequence}`} onClose={onToggle}>
          <EventActions worldId={worldId} view={view} event={event} canRetcon={canRetcon} canBranch={canBranch} done={onToggle} />
        </SheetDialog>
      )}
    </article>
  );
}

function EventActions({ worldId, view, event, canRetcon, canBranch, done }: {
  worldId: string;
  view: WorldView;
  event: EventView;
  canRetcon: boolean;
  canBranch: boolean;
  done(): void;
}) {
  const [correction, setCorrection] = useState("");
  const [branchId, setBranchId] = useState(`${worldId}-at-${event.sequence}`);
  const [branchName, setBranchName] = useState(`${view.world.name} (from #${event.sequence})`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function retcon(submit: FormEvent) {
    submit.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.retcon(worldId, event.sequence, correction);
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
      {canRetcon && (
        <form onSubmit={(submit) => void retcon(submit)} className="stack">
          <label className="field">
            Retcon: say what really happened. Those who perceived this get the correction, and their agents stop seeing it.
            <input value={correction} onChange={(change) => setCorrection(change.target.value)} placeholder="e.g. The door is still locked; nobody opened it." />
          </label>
          <div><button type="submit" disabled={busy || !correction.trim()}>Retcon #{event.sequence}</button></div>
        </form>
      )}
      {canBranch && (
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
