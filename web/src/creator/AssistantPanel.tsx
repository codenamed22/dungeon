import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, CircleAlert, Sparkles, Square, Undo2, Wrench, X } from "lucide-react";
import { api, ApiError, errorText } from "../api.ts";
import type { AssistantEvent } from "../api.ts";
import type { ChatEntry, CreatorUsage, Draft, ModelInfo, ToolLine } from "../types.ts";
import { NARROW, useDrag, useMedia, useOverlay, useStored } from "../ui/hooks.ts";
import type { DraftEditor } from "./useDraft.ts";

const SUGGESTIONS = [
  "Draft a first date at a night market",
  "Set up a 3 a.m. outage for two engineers",
  "Add a character who lies",
  "Give it an ending",
  "What's missing?",
];

/** Reading the draft or checking it changes nothing, so the change card leaves those out. */
const READS = new Set(["get_draft", "check_draft"]);

interface LiveRun {
  message: string;
  /** The draft before the run, which Undo puts back. */
  before: Draft;
  revisionBefore: number;
  steps: ({ kind: "text"; text: string } | ({ kind: "tool" } & ToolLine))[];
  usage: CreatorUsage | null;
  model: string | null;
}

const money = (cost: number) => (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);

function usageText(usage: CreatorUsage): string {
  const tokens = `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`;
  return usage.cost === null ? tokens : `${money(usage.cost)} · ${tokens}`;
}

/**
 * The AI creator: a tab on the right edge that pulls out a chat panel. It
 * edits the draft directly through the same operations as the forms; each
 * message's changes can be undone while nothing has changed since.
 */
export function AssistantPanel({ editor, draftId, launch }: { editor: DraftEditor; draftId: string; launch: { assistant: boolean; prompt: string } }) {
  const overlay = useOverlay("creator");
  const narrow = useMedia(NARROW);
  const panel = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [text, setText] = useState(launch.prompt);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [befores, setBefores] = useState<Map<string, Draft>>(() => new Map());
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [seenIntro, setSeenIntro] = useStored<"yes" | "no">("dungeons.creatorIntro", "no");
  const [chosenModel, setChosenModel] = useStored<string>("dungeons.creatorModel", "");
  const [picking, setPicking] = useState(false);
  const [server, setServer] = useState<{ model: string; keyConfigured: boolean } | null>(null);
  const controller = useRef<AbortController | null>(null);
  /** Whether the tab was dragged, so the click that ends a drag doesn't also open it. */
  const dragged = useRef(false);
  const { view } = editor;
  const chat = view?.chat ?? [];
  const running = live !== null;
  const width = () => panel.current?.offsetWidth ?? 420;

  useEffect(() => {
    api.creator().then(setServer).catch(() => setServer(null));
  }, []);
  useEffect(() => {
    if (launch.assistant) overlay.show();
    // Only on arriving from "Describe it to the AI".
  }, []);
  useEffect(() => () => controller.current?.abort(), []);

  // The page makes room for the panel on wide screens and stops scrolling under it on narrow ones.
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
  }, [chat.length, live?.steps.length, problem]);

  // The tab follows a drag to the left; the panel's header follows a drag to the right.
  const openDrag = useDrag({
    axis: "x",
    onStart: () => {
      dragged.current = true;
      setDrag(width());
    },
    onMove: (delta) => setDrag(Math.min(width(), Math.max(0, width() + delta))),
    onEnd: (delta, velocity) => {
      setDrag(null);
      if (delta < -width() / 3 || velocity < -0.5) overlay.show();
    },
  });
  const closeDrag = useDrag({
    axis: "x",
    ignore: "button, input, textarea, select, a",
    onStart: () => setDrag(0),
    onMove: (delta) => setDrag(Math.max(0, delta)),
    onEnd: (delta, velocity) => {
      setDrag(null);
      if (delta > width() / 3 || velocity > 0.5) overlay.hide();
    },
  });

  const spent = useMemo(() => {
    const all = [...chat.map((entry) => entry.usage), ...(live?.usage ? [live.usage] : [])];
    if (all.length === 0) return null;
    return all.some((usage) => usage.cost === null) ? null : all.reduce((sum, usage) => sum + (usage.cost ?? 0), 0);
  }, [chat, live?.usage]);

  /** After a stop or a dropped connection, waits for the server to finish saving, then shows what it kept. */
  async function settle(run: LiveRun) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const latest = await api.draft(draftId);
        if (!latest.busy) {
          const entry = [...latest.chat].reverse().find((candidate) => candidate.revisionBefore === run.revisionBefore && candidate.message === run.message);
          if (entry) setBefores((current) => new Map(current).set(entry.id, run.before));
          editor.adopt(latest);
          return;
        }
      } catch {
        // Try again shortly.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await editor.reload();
  }

  async function send(message: string) {
    const trimmed = message.trim();
    if (!trimmed || running || !editor.draft) return;
    setProblem(null);
    let saved;
    try {
      saved = await editor.flush();
    } catch (error) {
      setProblem(`Your last change isn't saved, so the AI creator can't start: ${errorText(error)}`);
      return;
    }
    const run: LiveRun = { message: trimmed, before: saved.draft, revisionBefore: saved.revision, steps: [], usage: null, model: null };
    setLive(run);
    setText("");
    editor.setAssisting(true);
    const abort = new AbortController();
    controller.current = abort;
    let finished = false;
    const update = (change: (current: LiveRun) => LiveRun) => setLive((current) => (current ? change(current) : current));
    const onEvent = (event: AssistantEvent) => {
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
        case "draft":
          editor.follow(event.draft, event.revision);
          break;
        case "usage":
          update((current) => ({ ...current, usage: event.usage }));
          break;
        case "done":
          finished = true;
          setBefores((current) => new Map(current).set(event.entry.id, run.before));
          editor.adopt(event.draft);
          break;
        case "error":
          setProblem(event.message);
          break;
        case "heartbeat":
          break;
      }
    };
    try {
      await api.assist(draftId, { message: trimmed, expectedRevision: saved.revision, ...(chosenModel ? { model: chosenModel } : {}) }, onEvent, abort.signal);
    } catch (error) {
      if (error instanceof ApiError) {
        // Refused before it started: nothing changed, so the message goes back in the box.
        setProblem(error.code === "STALE_REVISION" ? "The draft changed somewhere else. Reload the page, then try again." : error.message);
        setText(trimmed);
        finished = true;
      } else if (!abort.signal.aborted) {
        setProblem(`Lost touch with the AI creator: ${errorText(error)}. Anything it changed so far is kept.`);
      }
    } finally {
      controller.current = null;
      if (!finished) await settle(run);
      editor.setAssisting(false);
      setLive(null);
    }
  }

  async function undo(entry: ChatEntry) {
    const before = befores.get(entry.id);
    if (!before) return;
    setUndoing(entry.id);
    setProblem(null);
    try {
      const current = await editor.flush();
      if (current.revision !== entry.revisionAfter) {
        setProblem("The draft has changed since, so this can no longer be undone here. Change it back by hand, or ask the AI creator.");
        return;
      }
      // Saved against the revision the AI produced: if anything changed since, this fails instead of losing it.
      editor.adopt(await api.saveDraft(draftId, before, entry.revisionAfter));
      setUndone((done) => new Set(done).add(entry.id));
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setUndoing(null);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !narrow && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(text);
    }
  }

  const model = chosenModel || live?.model || server?.model || "the default model";
  const noKey = server !== null && !server.keyConfigured;
  const open = overlay.open || drag !== null;
  const transform = drag === null ? undefined : `translateX(${drag}px)`;

  return (
    <>
      {!overlay.open && (
        <button type="button" className="creator-tab" aria-label="Open the AI creator" title="Open the AI creator, or drag it out" {...openDrag}
          onPointerDown={(event) => {
            dragged.current = false;
            openDrag.onPointerDown(event);
          }}
          onClick={() => {
            if (!dragged.current) overlay.show();
            dragged.current = false;
          }}>
          <Sparkles size={16} />
          <span className="label">Creator</span>
        </button>
      )}
      <aside ref={panel} className={`creator-panel ${overlay.open && drag === null ? "open" : ""} ${drag !== null ? "dragging" : ""}`}
        style={transform ? { transform } : undefined} aria-label="AI creator" inert={!open}>
        <div className="assistant-header" {...closeDrag}>
          <span className="assistant-mark"><Sparkles size={16} /></span>
          <strong>AI creator</strong>
          {spent !== null && <span className="muted small" title="Spent on this draft">{money(spent)}</span>}
          <button type="button" className="icon-button" aria-label="Close the AI creator" onClick={overlay.hide}><X size={18} /></button>
        </div>
        {seenIntro === "no" ? (
          <div className="assistant-intro">
            <Sparkles size={22} />
            <h3>Build the world by asking</h3>
            <p>The AI creator writes places, characters, challenges, and personas into this draft while you watch, and tells you what it changed. You can undo each message.</p>
            <p>Each message spends OpenRouter credits: usually a few cents, and it stops at $0.50. It uses <strong>{model}</strong>; you can choose another below.</p>
            <button type="button" className="primary" onClick={() => setSeenIntro("yes")}>Got it</button>
          </div>
        ) : (
          <div className="assistant-log" ref={log} aria-live="polite">
            {chat.length === 0 && !live && (
              <div className="assistant-empty">
                <p>Ask for a whole world, or one piece at a time. It can read everything in the draft.</p>
                <div className="assistant-chips">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" disabled={running || noKey} onClick={() => setText(suggestion)}>{suggestion}</button>
                  ))}
                </div>
              </div>
            )}
            {chat.map((entry) => (
              <Turn key={entry.id} entry={entry}
                undo={befores.has(entry.id) && !undone.has(entry.id) && view?.revision === entry.revisionAfter && !running ? () => void undo(entry) : null}
                undone={undone.has(entry.id)} undoing={undoing === entry.id} />
            ))}
            {live && (
              <>
                <p className="bubble user">{live.message}</p>
                {live.steps.map((step, index) => (step.kind === "text"
                  ? <p key={index} className="bubble assistant">{step.text}</p>
                  : <ToolRow key={index} line={step} />))}
                <p className="assistant-note"><span className="status busy pulse" />Working{live.usage ? ` · ${usageText(live.usage)}` : ""}</p>
              </>
            )}
            {problem && <p className="assistant-error" role="alert"><CircleAlert size={14} /> {problem}</p>}
          </div>
        )}
        {picking && <ModelPicker current={chosenModel} fallback={server?.model ?? null} onPick={(id) => { setChosenModel(id); setPicking(false); }} onClose={() => setPicking(false)} />}
        <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
          {noKey && <p className="assistant-error">Set OPENROUTER_API_KEY in .env.local and restart the server to use the AI creator.</p>}
          <div className="composer">
            <textarea rows={Math.min(5, Math.max(1, text.split("\n").length))} value={text} maxLength={4000} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
              placeholder={running ? "Working…" : "Ask the AI creator…"} aria-label="Message to the AI creator" disabled={running || noKey || seenIntro === "no"} />
            {running ? (
              <button type="button" className="round-send" aria-label="Stop" title="Stop: it keeps what it has done so far" onClick={() => controller.current?.abort()}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className="round-send" aria-label="Send" disabled={!text.trim() || noKey || seenIntro === "no"}><ArrowUp size={18} /></button>
            )}
          </div>
          <div className="assistant-meta">
            <button type="button" onClick={() => setPicking((shown) => !shown)} aria-expanded={picking} title="Choose the model">
              {model} <ChevronDown size={11} />
            </button>
            <span className="grow" />
            <span>{spent === null ? (chat.length ? "cost not reported" : "") : `${money(spent)} spent here`}</span>
          </div>
        </form>
      </aside>
    </>
  );
}

function ToolRow({ line }: { line: ToolLine }) {
  return (
    <p className={`tool-line ${line.ok ? "" : "failed"}`}>
      {line.ok ? <Wrench size={12} /> : <X size={12} />}
      <span>{line.summary}</span>
    </p>
  );
}

function Turn({ entry, undo, undone, undoing }: { entry: ChatEntry; undo: (() => void) | null; undone: boolean; undoing: boolean }) {
  const [showSteps, setShowSteps] = useState(false);
  const changes = entry.tools.filter((line) => line.ok && !READS.has(line.name));
  const failed = entry.tools.filter((line) => !line.ok).length;
  const changed = entry.revisionAfter !== entry.revisionBefore;
  return (
    <>
      <p className="bubble user">{entry.message}</p>
      {entry.reply && <p className="bubble assistant">{entry.reply}</p>}
      {entry.stopped && <p className="assistant-note"><Square size={11} /> {entry.stopped}</p>}
      {entry.error && <p className="assistant-error"><CircleAlert size={14} /> {entry.error}</p>}
      {(changed || entry.tools.length > 0) && (
        <div className={`change-card ${undone ? "undone" : ""}`}>
          <div className="row">
            <strong>{undone ? "Undone" : changed ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : "No changes"}</strong>
            {undo && (
              <button type="button" className="small" disabled={undoing} onClick={undo}><Undo2 size={14} />Undo</button>
            )}
          </div>
          {entry.tools.length > 0 && (
            <button type="button" className="text-button small" aria-expanded={showSteps} onClick={() => setShowSteps((shown) => !shown)}>
              {showSteps ? "Hide" : "Show"} {entry.tools.length} step{entry.tools.length === 1 ? "" : "s"}{failed ? `, ${failed} refused` : ""}
            </button>
          )}
          {showSteps && entry.tools.map((line, index) => <ToolRow key={index} line={line} />)}
          <span className="muted small">{usageText(entry.usage)} · {entry.model}</span>
        </div>
      )}
    </>
  );
}

function ModelPicker({ current, fallback, onPick, onClose }: { current: string; fallback: string | null; onPick(id: string): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      api.models(query)
        .then((found) => { setModels(found.filter((model) => model.tools)); setError(null); })
        .catch((problem) => setError(errorText(problem)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <div className="model-picker">
      <div className="row">
        <strong className="grow small">Model for the AI creator</strong>
        <button type="button" className="icon-button" aria-label="Close the model list" onClick={onClose}><X size={16} /></button>
      </div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models that can call tools" aria-label="Search models" autoFocus />
      {error && <p className="error small">{error}</p>}
      <ul className="model-results">
        <li>
          <button type="button" className="link small" onClick={() => onPick("")}>
            {current === "" && <Check size={12} />} The server's default{fallback ? ` (${fallback})` : ""}
          </button>
        </li>
        {models === null && <li className="muted small">Loading…</li>}
        {models?.length === 0 && <li className="muted small">No model that can call tools matches.</li>}
        {models?.map((model) => (
          <li key={model.id}>
            <button type="button" className="link small" onClick={() => onPick(model.id)}>
              {current === model.id && <Check size={12} />} {model.id}
            </button>
            {model.promptPerMillion !== null && model.completionPerMillion !== null && (
              <span className="muted small"> · ${model.promptPerMillion.toFixed(2)} / ${model.completionPerMillion.toFixed(2)} per M tokens</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
