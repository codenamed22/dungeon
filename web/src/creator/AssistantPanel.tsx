import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, CircleAlert, FileText, Paperclip, Sparkles, Square, Undo2, X } from "lucide-react";
import { api, ApiError, errorText } from "../api.ts";
import type { AssistantEvent } from "../api.ts";
import type { BuildStepId, ChatEntry, CreatorUsage, Draft, ToolLine } from "../types.ts";
import { MAX_SAMPLE_CHARACTERS, normalizeSample } from "../../../src/creator/samples.ts";
import { BUILD_STEPS, buildStep, nextBuildStep } from "../../../src/creator/steps.ts";
import { NARROW, useDrag, useMedia, useOverlay, useStored } from "../ui/hooks.ts";
import { ModelPicker, money, ToolRow, totalCost, usageText } from "../assistant/parts.tsx";
import type { DraftEditor } from "./useDraft.ts";

const SUGGESTIONS = [
  "Draft a first date at a night market",
  "Set up a 3 a.m. outage for two engineers",
  "Add a character who lies",
  "Give it an ending",
  "What's missing?",
];

/** Reading the draft, an example, or the sample chats, or checking the draft, changes nothing, so the change card leaves those out. */
const READS = new Set(["get_draft", "check_draft", "get_example", "read_samples"]);
/** A file this large is no chat export the creator could take, so it isn't read at all. */
const MAX_SAMPLE_FILE_BYTES = 8 * 1024 * 1024;
const SAMPLE_TYPES = ".txt,.md,.csv,.json,.log,text/plain";

interface LiveRun {
  message: string;
  step: BuildStepId | undefined;
  /** The draft before the run, which Undo puts back. */
  before: Draft;
  revisionBefore: number;
  steps: ({ kind: "text"; text: string } | ({ kind: "tool" } & ToolLine))[];
  usage: CreatorUsage | null;
  model: string | null;
}

/** Nothing written yet, so a guided build can start. */
const isEmpty = (draft: Draft) => draft.seed.locations.length === 0 && draft.seed.characters.length === 0 && !draft.cast.premise;

const stepNumber = (id: BuildStepId) => BUILD_STEPS.findIndex((step) => step.id === id) + 1;

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
  const [stepwise, setStepwise] = useStored<"yes" | "no">("dungeons.creatorStepwise", "yes");
  /** The message after which the director left a guided build; kept, so a reload doesn't bring the steps back. */
  const [leftAt, setLeftAt] = useStored<string>(`dungeons.creatorLeftAt.${draftId}`, "");
  const [picking, setPicking] = useState(false);
  const [server, setServer] = useState<{ model: string; keyConfigured: boolean } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sampling, setSampling] = useState(false);
  /** Whether the tab was dragged, so the click that ends a drag doesn't also open it. */
  const dragged = useRef(false);
  const { view } = editor;
  const chat = view?.chat ?? [];
  const samples = view?.samples ?? [];
  const running = live !== null;
  const width = () => panel.current?.offsetWidth ?? 420;
  const last = chat.at(-1);
  /** A guided build in progress: the step the last message ran, until the last step or the director leaves. */
  const guided = last?.step !== undefined && nextBuildStep(last.step) !== null && leftAt !== last.id ? last.step : null;
  const empty = editor.draft !== null && editor.draft !== undefined && isEmpty(editor.draft);
  /** The next message starts a guided build. */
  const starting = guided === null && empty && stepwise === "yes";

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

  const spent = useMemo(() => totalCost([...chat.map((entry) => entry.usage), ...(live?.usage ? [live.usage] : [])]), [chat, live?.usage]);

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

  /**
   * Adds chat files for the AI creator to draw on, one at a time, stopping at
   * the first it can't take. The server judges the limits; a file far beyond
   * them is turned away here, before it is sent.
   */
  async function addSamples(files: File[]) {
    if (files.length === 0) return;
    setProblem(null);
    setSampling(true);
    try {
      for (const file of files) {
        const tooLong = `"${file.name}" is too long for the AI creator, which takes ${MAX_SAMPLE_CHARACTERS.toLocaleString("en-US")} characters of sample chats in all. Trim it to the conversations that show these people best.`;
        if (file.size > MAX_SAMPLE_FILE_BYTES) throw new Error(tooLong);
        const text = normalizeSample(await file.text());
        if (text.length > MAX_SAMPLE_CHARACTERS) throw new Error(tooLong);
        await editor.flush();
        editor.adopt(await api.addSample(draftId, file.name, text));
      }
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setSampling(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeSample(sampleId: string) {
    setProblem(null);
    setSampling(true);
    try {
      await editor.flush();
      editor.adopt(await api.removeSample(draftId, sampleId));
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setSampling(false);
    }
  }

  /** Sends a message: as the given step of a guided build, outside one (null), or as the panel's state implies. */
  async function send(message: string, step?: BuildStepId | null) {
    const trimmed = message.trim();
    if (!trimmed || running || !editor.draft) return;
    const runStep = step === undefined ? guided ?? (starting ? "story" : undefined) : step ?? undefined;
    setProblem(null);
    let saved;
    try {
      saved = await editor.flush();
    } catch (error) {
      setProblem(`Your last change isn't saved, so the AI creator can't start: ${errorText(error)}`);
      return;
    }
    const run: LiveRun = { message: trimmed, step: runStep, before: saved.draft, revisionBefore: saved.revision, steps: [], usage: null, model: null };
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
      await api.assist(draftId, {
        message: trimmed, expectedRevision: saved.revision, ...(chosenModel ? { model: chosenModel } : {}), ...(runStep ? { step: runStep } : {}),
      }, onEvent, abort.signal);
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
                <p>{starting
                  ? "Describe the world you want. It builds it with you in five steps (story, places, characters, challenges, endings) and stops for your approval after each."
                  : "Ask for a whole world, or one piece at a time. It can read everything in the draft."}</p>
                <div className="assistant-chips">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" disabled={running || noKey} onClick={() => setText(suggestion)}>{suggestion}</button>
                  ))}
                </div>
                <p className="small">Have chats that sound like the people you want? Add them with <strong>Sample chats</strong> below, and it draws on their voices.</p>
              </div>
            )}
            {chat.map((entry) => (
              <Turn key={entry.id} entry={entry}
                undo={befores.has(entry.id) && !undone.has(entry.id) && view?.revision === entry.revisionAfter && !running ? () => void undo(entry) : null}
                undone={undone.has(entry.id)} undoing={undoing === entry.id} />
            ))}
            {guided && !live && (
              <StepCard current={guided} disabled={noKey} unfinished={Boolean(last!.stopped || last!.error)}
                onRetry={() => void send(`Finish step ${stepNumber(guided)}: ${buildStep(guided).label}.`, guided)}
                onContinue={() => {
                  const next = nextBuildStep(guided)!;
                  void send(`Approved. On to step ${stepNumber(next.id)}: ${next.label}.`, next.id);
                }}
                onFinish={() => void send("Build the rest of the world, without stopping between steps.", null)}
                onLeave={() => setLeftAt(last!.id)} />
            )}
            {live && (
              <>
                {live.step && <StepLabel step={live.step} />}
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
        {picking && <ModelPicker title="Model for the AI creator" current={chosenModel} fallback={server?.model ?? null} onPick={(id) => { setChosenModel(id); setPicking(false); }} onClose={() => setPicking(false)} />}
        <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
          {noKey && <p className="assistant-error">Set OPENROUTER_API_KEY in .env.local and restart the server to use the AI creator.</p>}
          {samples.length > 0 && (
            <div className="sample-files" aria-label="Sample chats">
              {samples.map((sample) => (
                <span key={sample.id} className="sample-file"
                  title={`${sample.name}: ${sample.characters.toLocaleString("en-US")} characters. The AI creator reads it for inspiration; it never goes into the world or its downloads.`}>
                  <FileText size={12} />
                  <span className="name">{sample.name}</span>
                  <span className="size">{shortCount(sample.characters)}</span>
                  <button type="button" aria-label={`Remove ${sample.name}`} disabled={running || sampling} onClick={() => void removeSample(sample.id)}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="composer">
            <textarea rows={Math.min(5, Math.max(1, text.split("\n").length))} value={text} maxLength={16000} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
              placeholder={running ? "Working…" : guided ? `Or tell it what to change in ${buildStep(guided).label.toLowerCase()}…` : starting ? "Describe the world to build…" : "Ask the AI creator…"}
              aria-label="Message to the AI creator" disabled={running || noKey || seenIntro === "no"} />
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
            <button type="button" className="sample-add" aria-label="Sample chats" disabled={running || sampling || seenIntro === "no"} onClick={() => fileInput.current?.click()}
              title={`Add chats for the AI creator to draw on: text exports of conversations, up to ${MAX_SAMPLE_CHARACTERS.toLocaleString("en-US")} characters in all. It sends them to the model when it reads them; they never go into the world or its downloads.`}>
              <Paperclip size={11} /><span className="label">{sampling ? "Adding…" : "Sample chats"}</span>
            </button>
            <input ref={fileInput} type="file" accept={SAMPLE_TYPES} multiple hidden aria-label="Sample chat files"
              onChange={(event) => void addSamples([...(event.target.files ?? [])])} />
            {empty && guided === null && !running && (
              <label className="step-toggle" title="Build a new world in five steps, approving each">
                <input type="checkbox" checked={stepwise === "yes"} onChange={(event) => setStepwise(event.target.checked ? "yes" : "no")} />
                Step by step
              </label>
            )}
            <span className="grow" />
            <span>{spent === null ? (chat.length ? "cost not reported" : "") : `${money(spent)} spent here`}</span>
          </div>
        </form>
      </aside>
    </>
  );
}

function StepLabel({ step }: { step: BuildStepId }) {
  return <p className="step-label">Step {stepNumber(step)} of {BUILD_STEPS.length} · {buildStep(step).label}</p>;
}

/** Between the steps of a guided build: where it is, and the director's choice of what next. */
function StepCard({ current, disabled, unfinished, onRetry, onContinue, onFinish, onLeave }: {
  current: BuildStepId; disabled: boolean; unfinished: boolean; onRetry(): void; onContinue(): void; onFinish(): void; onLeave(): void;
}) {
  // An unfinished step is still the current one.
  const done = stepNumber(current) - (unfinished ? 1 : 0);
  const next = nextBuildStep(current)!;
  return (
    <div className="step-card">
      <ol className="step-track" aria-label="Steps">
        {BUILD_STEPS.map((step, index) => (
          <li key={step.id} className={index < done ? "done" : index === done ? "next" : ""} aria-current={index === done ? "step" : undefined}>
            {index < done && <Check size={11} />}{step.label}
          </li>
        ))}
      </ol>
      <p className="muted small">{unfinished
        ? `It stopped before finishing the ${buildStep(current).label.toLowerCase()}. Finish it, or type what to change.`
        : `Happy with the ${buildStep(current).label.toLowerCase()}? Continue, or type what to change.`}</p>
      <div className="row">
        {unfinished && <button type="button" className="primary small" disabled={disabled} onClick={onRetry}>Finish {buildStep(current).label.toLowerCase()}</button>}
        <button type="button" className={`${unfinished ? "" : "primary "}small`} disabled={disabled} onClick={onContinue}>Continue: {next.label}</button>
        <button type="button" className="text-button small" disabled={disabled} onClick={onFinish}>Build the rest at once</button>
        <button type="button" className="text-button small" onClick={onLeave}>Leave step by step</button>
      </div>
    </div>
  );
}

function Turn({ entry, undo, undone, undoing }: { entry: ChatEntry; undo: (() => void) | null; undone: boolean; undoing: boolean }) {
  const [showSteps, setShowSteps] = useState(false);
  const changes = entry.tools.filter((line) => line.ok && !READS.has(line.name));
  const failed = entry.tools.filter((line) => !line.ok).length;
  const changed = entry.revisionAfter !== entry.revisionBefore;
  return (
    <>
      {entry.step && <StepLabel step={entry.step} />}
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

/** A length in characters, briefly: 840, or 42k. */
function shortCount(characters: number): string {
  return characters < 1000 ? `${characters}` : `${Math.round(characters / 1000)}k`;
}
