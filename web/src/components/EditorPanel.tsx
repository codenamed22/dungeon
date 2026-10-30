import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, ChevronDown, CircleAlert, Pause, Square, Trash2, Undo2, WandSparkles, X } from "lucide-react";
import { api, ApiError, errorText } from "../api.ts";
import type { EditorStreamEvent } from "../api.ts";
import type { CreatorUsage, EditorEntry, EditorPass, ProposedChange, RunStatus, ToolLine, WorldView } from "../types.ts";
import { ModelPicker, money, ToolRow, totalCost, usageText } from "../assistant/parts.tsx";
import { NARROW, useDrag, useMedia, useStored } from "../ui/hooks.ts";
import type { Overlay } from "../ui/hooks.ts";

const SUGGESTIONS = [
  "The dialogue repeats itself",
  "Nothing is happening",
  "Someone is out of character",
  "The narrator says too much",
];

const KINDS: Record<ProposedChange["kind"], string> = {
  persona: "persona", style: "style", steer: "steering", event: "event", entrance: "arrival", exit: "departure", edit_line: "edit", delete_line: "delete",
};

/** Reading and proposing change nothing, so the change card leaves them out. */
const READS = new Set(["read_story", "read_world", "read_setup", "read_report", "read_character", "propose_changes"]);

interface LiveRun {
  message: string;
  pass: EditorPass;
  steps: ({ kind: "text"; text: string } | ({ kind: "tool" } & ToolLine))[];
  proposal: ProposedChange[] | null;
  usage: CreatorUsage | null;
  model: string | null;
}

/** Whether two JSON values are the same, whatever the order of their keys. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length && keys.every((key) => same(left[key], right[key]));
}

/** The changes a fix is asked to make, numbered as the review numbered them. */
function fixMessage(changes: readonly ProposedChange[], chosen: readonly number[], note: string): string {
  const list = chosen.map((index) => `${index + 1}. ${changes[index]!.title}: ${changes[index]!.detail}`);
  return [`Make ${chosen.length === 1 ? "this change" : "these changes"} from your review:`, ...list, ...(note.trim() ? ["", `Note: ${note.trim()}`] : [])].join("\n");
}

/**
 * The story editor: a panel that pulls in from the right, opened from the
 * world's header. It reviews the story and proposes changes; once the director
 * ticks the ones they want, it makes them. Agent changes can be undone while
 * the setup is unchanged since; story changes are lines in the story, which
 * can be edited or deleted like any other.
 */
export function EditorPanel({ worldId, view, run, overlay, onWorld }: {
  worldId: string; view: WorldView; run: RunStatus | null; overlay: Overlay; onWorld(view: WorldView): void;
}) {
  const narrow = useMedia(NARROW);
  const panel = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [chat, setChat] = useState<EditorEntry[] | null>(null);
  const [text, setText] = useState("");
  const [live, setLive] = useState<LiveRun | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [chosenModel, setChosenModel] = useStored<string>("dungeons.editorModel", "");
  const [picking, setPicking] = useState(false);
  const [server, setServer] = useState<{ model: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Events arrive after renders; they update the latest view, not the one the run started with.
  const latest = useRef(view);
  latest.current = view;
  const working = live !== null;
  const playing = run?.state === "running" || run?.state === "pausing";
  const noKey = !view.keyConfigured;
  const blocked = working || playing || noKey;
  const width = () => panel.current?.offsetWidth ?? 420;
  const entries = chat ?? [];

  /** The newest proposal, until a fix follows it. */
  const pending = useMemo(() => {
    for (const entry of [...entries].reverse()) {
      if (entry.pass === "fix") return null;
      if (entry.proposal?.length) return entry;
    }
    return null;
  }, [entries]);

  useEffect(() => {
    if (!overlay.open || chat !== null) return;
    api.editor(worldId).then((loaded) => setChat(loaded.chat)).catch((error) => setProblem(errorText(error)));
    api.creator().then(setServer).catch(() => setServer(null));
  }, [overlay.open, chat, worldId]);
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    document.body.classList.toggle("panel-open", overlay.open);
    return () => document.body.classList.remove("panel-open");
  }, [overlay.open]);

  useEffect(() => {
    if (!overlay.open) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !picking) overlay.hide();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [overlay, picking]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [entries.length, live?.steps.length, live?.proposal, problem, playing]);

  useEffect(() => {
    if (!playing) setPausing(false);
  }, [playing]);

  const closeDrag = useDrag({
    axis: "x",
    ignore: "button, input, textarea, select, a, label",
    onStart: () => setDrag(0),
    onMove: (delta) => setDrag(Math.max(0, delta)),
    onEnd: (delta, velocity) => {
      setDrag(null);
      if (delta > width() / 3 || velocity > 0.5) overlay.hide();
    },
  });

  const spent = useMemo(() => totalCost([...entries.map((entry) => entry.usage), ...(live?.usage ? [live.usage] : [])]), [entries, live?.usage]);

  /** After a stop or a dropped connection, waits for the server to finish saving, then shows what it kept. */
  async function settle() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const current = await api.editor(worldId);
        if (!current.busy) {
          setChat(current.chat);
          onWorld(await api.world(worldId));
          return;
        }
      } catch {
        // Try again shortly.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async function send(message: string, pass: EditorPass) {
    const trimmed = message.trim();
    if (!trimmed || blocked) return;
    setProblem(null);
    setLive({ message: trimmed, pass, steps: [], proposal: null, usage: null, model: null });
    if (pass === "review") setText("");
    const abort = new AbortController();
    controller.current = abort;
    let finished = false;
    const update = (change: (current: LiveRun) => LiveRun) => setLive((current) => (current ? change(current) : current));
    const onEvent = (event: EditorStreamEvent) => {
      switch (event.type) {
        case "start":
          update((current) => ({ ...current, model: event.model }));
          break;
        case "text":
          update((current) => ({ ...current, steps: [...current.steps, { kind: "text", text: event.text }] }));
          break;
        case "tool":
          update((current) => ({ ...current, steps: [...current.steps, { kind: "tool", name: event.name, summary: event.summary, ok: event.ok }] }));
          break;
        case "proposal":
          update((current) => ({ ...current, proposal: event.changes }));
          break;
        case "setup":
          onWorld({ ...latest.current, setup: event.setup, setupSaved: true });
          break;
        case "usage":
          update((current) => ({ ...current, usage: event.usage }));
          break;
        case "done":
          finished = true;
          setChat(event.editor.chat);
          onWorld(event.world);
          break;
        case "error":
          setProblem(event.message);
          break;
        case "heartbeat":
          break;
      }
    };
    try {
      await api.edit(worldId, { message: trimmed, pass, ...(chosenModel ? { model: chosenModel } : {}) }, onEvent, abort.signal);
    } catch (error) {
      if (error instanceof ApiError) {
        // Refused before it started: nothing changed, so a typed message goes back in the box.
        setProblem(error.message);
        if (pass === "review") setText(trimmed);
        finished = true;
      } else if (!abort.signal.aborted) {
        setProblem(`Lost touch with the story editor: ${errorText(error)}. Anything it changed so far is kept.`);
      }
    } finally {
      controller.current = null;
      if (!finished) await settle();
      setLive(null);
    }
  }

  async function undo(entry: EditorEntry) {
    setUndoing(entry.id);
    setProblem(null);
    try {
      onWorld(await api.saveSetup(worldId, entry.setupBefore));
      setUndone((done) => new Set(done).add(entry.id));
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setUndoing(null);
    }
  }

  async function deleteFrom(entry: EditorEntry) {
    if (!window.confirm("Delete this message and all newer editor messages from chat history? Changes already made to the world will stay.")) return;
    setDeleting(entry.id);
    setProblem(null);
    try {
      const updated = await api.deleteEditorMessage(worldId, entry.id);
      setChat(updated.chat);
      setUndone((current) => new Set([...current].filter((id) => updated.chat.some((saved) => saved.id === id))));
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setDeleting(null);
    }
  }

  async function pause() {
    setPausing(true);
    try {
      await api.pause(worldId);
    } catch (error) {
      setPausing(false);
      setProblem(errorText(error));
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !narrow && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(text, "review");
    }
  }

  const model = chosenModel || live?.model || server?.model || "the default model";
  const ended = view.world.endedWith !== undefined && view.world.endedWith !== null;
  const open = overlay.open || drag !== null;
  const transform = drag === null ? undefined : `translateX(${drag}px)`;

  return (
    <aside ref={panel} className={`creator-panel ${overlay.open && drag === null ? "open" : ""} ${drag !== null ? "dragging" : ""}`}
      style={transform ? { transform } : undefined} aria-label="Story editor" inert={!open}>
      <div className="assistant-header" {...closeDrag}>
        <span className="assistant-mark"><WandSparkles size={16} /></span>
        <strong>Story editor</strong>
        {spent !== null && <span className="muted small" title="Spent on this world">{money(spent)}</span>}
        <button type="button" className="icon-button" aria-label="Close the story editor" onClick={overlay.hide}><X size={18} /></button>
      </div>
      <div className="assistant-log" ref={log} aria-live="polite">
        {chat === null && !problem && <p className="muted small">Loading…</p>}
        {chat !== null && entries.length === 0 && !live && (
          <div className="assistant-empty">
            <p>It reads the story so far, says what's working and what isn't, and proposes changes. Nothing changes until you approve them.</p>
            <p>{ended
              ? "The story has ended, so it can reword or delete lines, and change the agents for a branch."
              : "It can change the characters' personas, the narrator's style and pace, steer the characters, make things happen, and reword or delete lines."}{" "}
              Each message spends OpenRouter credits: usually a cent or two, and it stops at $0.50.</p>
            <button type="button" className="primary" disabled={blocked} onClick={() => void send("Review the story so far.", "review")}>
              <WandSparkles size={15} />Review the story
            </button>
            <div className="assistant-chips">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" disabled={blocked} onClick={() => setText(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        )}
        {entries.map((entry) => {
          const agentChange = !same(entry.setupBefore, entry.setupAfter);
          const canUndo = agentChange && !undone.has(entry.id) && same(view.setup, entry.setupAfter) && !working;
          return (
            <Turn key={entry.id} entry={entry} agentChange={agentChange} undone={undone.has(entry.id)} undoing={undoing === entry.id}
              undo={canUndo ? () => void undo(entry) : null}
              deleteMessage={() => void deleteFrom(entry)} deleting={deleting === entry.id || working || playing || deleting !== null}
              pending={entry === pending && !live ? { disabled: blocked, onApprove: (chosen, note) => void send(fixMessage(entry.proposal!, chosen, note), "fix") } : null} />
          );
        })}
        {live && (
          <>
            <p className="bubble user">{live.message}</p>
            {live.steps.map((step, index) => (step.kind === "text"
              ? <p key={index} className="bubble assistant">{step.text}</p>
              : <ToolRow key={index} line={step} />))}
            {live.proposal && <ProposalList changes={live.proposal} />}
            <p className="assistant-note"><span className="status busy pulse" />{live.pass === "fix" ? "Making the changes" : "Reading"}{live.usage ? ` · ${usageText(live.usage)}` : ""}</p>
          </>
        )}
        {playing && !live && (
          <div className="step-card" role="status">
            <p>The world is running. Pause it so the editor reads a story that isn't moving.</p>
            <div className="row">
              <button type="button" className="primary small" disabled={pausing || run?.state === "pausing"} onClick={() => void pause()}>
                <Pause size={14} />{pausing || run?.state === "pausing" ? "Pausing after this turn…" : "Pause the run"}
              </button>
            </div>
          </div>
        )}
        {problem && <p className="assistant-error" role="alert"><CircleAlert size={14} /> {problem}</p>}
      </div>
      {picking && <ModelPicker title="Model for the story editor" current={chosenModel} fallback={server?.model ?? null} onPick={(id) => { setChosenModel(id); setPicking(false); }} onClose={() => setPicking(false)} />}
      <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); void send(text, "review"); }}>
        {noKey && <p className="assistant-error">Set OPENROUTER_API_KEY in .env.local and restart the server to use the story editor.</p>}
        <div className="composer">
          <textarea rows={Math.min(5, Math.max(1, text.split("\n").length))} value={text} maxLength={16000} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
            placeholder={working ? "Working…" : playing ? "Pause the run first" : "What isn't working? Or ask it to review…"}
            aria-label="Message to the story editor" disabled={blocked} />
          {working ? (
            <button type="button" className="round-send" aria-label="Stop" title="Stop: it keeps what it has done so far" onClick={() => controller.current?.abort()}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="round-send" aria-label="Send" disabled={!text.trim() || blocked}><ArrowUp size={18} /></button>
          )}
        </div>
        <div className="assistant-meta">
          <button type="button" onClick={() => setPicking((shown) => !shown)} aria-expanded={picking} title="Choose the model">
            {model} <ChevronDown size={11} />
          </button>
          <span className="grow" />
          <span>{spent === null ? (entries.length ? "cost not reported" : "") : `${money(spent)} spent here`}</span>
        </div>
      </form>
    </aside>
  );
}

function ProposalList({ changes }: { changes: readonly ProposedChange[] }) {
  return (
    <ol className="proposal-list">
      {changes.map((change, index) => (
        <li key={index}><strong>{change.title}</strong> <span className="kind">{KINDS[change.kind]}</span></li>
      ))}
    </ol>
  );
}

/** The newest proposal, as a checklist: the ticked changes go to the fix, with an optional note. */
function ProposalCard({ changes, disabled, onApprove }: { changes: readonly ProposedChange[]; disabled: boolean; onApprove(chosen: number[], note: string): void }) {
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set());
  const [note, setNote] = useState("");
  const chosen = changes.map((_, index) => index).filter((index) => !skipped.has(index));
  const toggle = (index: number) => setSkipped((current) => {
    const next = new Set(current);
    if (!next.delete(index)) next.add(index);
    return next;
  });
  return (
    <div className="step-card proposal-card">
      <strong>Proposed changes</strong>
      <ul>
        {changes.map((change, index) => (
          <li key={index}>
            <label>
              <input type="checkbox" checked={!skipped.has(index)} onChange={() => toggle(index)} />
              <span>
                <strong>{change.title}</strong> <span className="kind">{KINDS[change.kind]}</span>
                <span className="detail">{change.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <input type="text" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="A note for the editor (optional)" aria-label="A note for the editor" />
      <div className="row">
        <button type="button" className="primary small" disabled={disabled || chosen.length === 0} onClick={() => onApprove(chosen, note)}>
          Make {chosen.length} change{chosen.length === 1 ? "" : "s"}
        </button>
        <span className="muted small">Persona and style changes can be undone; story changes become lines you can edit or delete.</span>
      </div>
    </div>
  );
}

function Turn({ entry, agentChange, undo, undone, undoing, deleteMessage, deleting, pending }: {
  entry: EditorEntry;
  agentChange: boolean;
  undo: (() => void) | null;
  undone: boolean;
  undoing: boolean;
  deleteMessage(): void;
  deleting: boolean;
  pending: { disabled: boolean; onApprove(chosen: number[], note: string): void } | null;
}) {
  const [showSteps, setShowSteps] = useState(false);
  const changes = entry.tools.filter((line) => line.ok && !READS.has(line.name));
  const failed = entry.tools.filter((line) => !line.ok).length;
  const proposal = entry.proposal ?? [];
  const deleteButton = (
    <button type="button" className="small" disabled={deleting} onClick={deleteMessage} title="Delete this and all newer editor messages">
      <Trash2 size={14} />{deleting ? "Deleting…" : "Delete from here"}
    </button>
  );
  return (
    <>
      <p className="bubble user">{entry.message}</p>
      {entry.reply && <p className="bubble assistant">{entry.reply}</p>}
      {entry.stopped && <p className="assistant-note"><Square size={11} /> {entry.stopped}</p>}
      {entry.error && <p className="assistant-error"><CircleAlert size={14} /> {entry.error}</p>}
      {proposal.length > 0 && (pending ? <ProposalCard changes={proposal} {...pending} /> : <ProposalList changes={proposal} />)}
      {entry.tools.length === 0 && (
        <div className="change-card">
          <div className="row"><strong>Message</strong>{deleteButton}</div>
        </div>
      )}
      {entry.tools.length > 0 && (
        <div className={`change-card ${undone ? "undone" : ""}`}>
          <div className="row">
            <strong>{undone ? "Agent changes undone" : changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : entry.pass === "review" ? "Review" : "No changes"}</strong>
            {undo && <button type="button" className="small" disabled={undoing} onClick={undo}><Undo2 size={14} />Undo agent changes</button>}
            {deleteButton}
          </div>
          {entry.committed.length > 0 && (
            <span className="muted small">
              Story lines {entry.committed.map((sequence) => `#${sequence}`).join(", ")}{agentChange ? "; these stay if you undo" : ""}. Edit or delete them in the story.
            </span>
          )}
          <button type="button" className="text-button small" aria-expanded={showSteps} onClick={() => setShowSteps((shown) => !shown)}>
            {showSteps ? "Hide" : "Show"} {entry.tools.length} step{entry.tools.length === 1 ? "" : "s"}{failed ? `, ${failed} refused` : ""}
          </button>
          {showSteps && entry.tools.map((line, index) => <ToolRow key={index} line={line} />)}
          <span className="muted small">{usageText(entry.usage)} · {entry.model}</span>
        </div>
      )}
    </>
  );
}
