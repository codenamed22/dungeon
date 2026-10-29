import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorText } from "../api.ts";
import type { Cast, ModelInfo, ModelSetup, NpcPersona, Persona, Setup, WorldView } from "../types.ts";

// Lists are edited one entry per line.
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const joined = (list: readonly string[] | undefined) => (list ?? []).join("\n");

interface PersonaDraft { summary: string; voice: string; goals: string; riskTolerance: Persona["riskTolerance"] }
interface NpcDraft { summary: string; voice: string; knowledge: string; wants: string; agenda: boolean; everyMinutes: number; aims: string }
type Pace = NonNullable<Cast["pace"]>;

interface Draft {
  premise: string;
  narratorStyle: string;
  pace: Pace;
  characters: Record<string, PersonaDraft | null>;
  npcs: Record<string, NpcDraft | null>;
  models: ModelSetup;
}

function draftOf(view: WorldView): Draft {
  const cast = view.setup.cast;
  const characters: Draft["characters"] = {};
  const npcs: Draft["npcs"] = {};
  for (const character of view.world.characters) {
    if (character.npc) {
      const persona = cast.npcs?.[character.id];
      npcs[character.id] = persona ? {
        summary: persona.summary,
        voice: persona.voice,
        knowledge: joined(persona.knowledge),
        wants: joined(persona.wants),
        agenda: persona.agenda !== undefined,
        everyMinutes: persona.agenda?.everyMinutes ?? 10,
        aims: joined(persona.agenda?.aims),
      } : null;
    } else {
      const persona = cast.characters[character.id];
      characters[character.id] = persona
        ? { summary: persona.summary, voice: persona.voice, goals: joined(persona.goals), riskTolerance: persona.riskTolerance }
        : null;
    }
  }
  return {
    premise: cast.premise ?? "", narratorStyle: cast.narratorStyle, pace: cast.pace ?? "action", characters, npcs, models: { ...view.setup.models },
  };
}

function setupOf(draft: Draft): Setup {
  const characters: Record<string, Persona> = {};
  for (const [id, persona] of Object.entries(draft.characters)) {
    if (persona) characters[id] = { summary: persona.summary, voice: persona.voice, goals: lines(persona.goals), riskTolerance: persona.riskTolerance };
  }
  const npcs: Record<string, NpcPersona> = {};
  for (const [id, persona] of Object.entries(draft.npcs)) {
    if (!persona) continue;
    npcs[id] = {
      summary: persona.summary,
      voice: persona.voice,
      knowledge: lines(persona.knowledge),
      wants: lines(persona.wants),
      ...(persona.agenda ? { agenda: { everyMinutes: persona.everyMinutes, aims: lines(persona.aims) } } : {}),
    };
  }
  return {
    cast: {
      ...(draft.premise.trim() ? { premise: draft.premise.trim() } : {}),
      narratorStyle: draft.narratorStyle,
      // Action is the default, so a cast that never chose a pace stays as it was.
      ...(draft.pace === "conversation" ? { pace: draft.pace } : {}),
      characters,
      ...(Object.keys(npcs).length > 0 ? { npcs } : {}),
    },
    models: draft.models,
  };
}

const blankPersona = (name: string): PersonaDraft => ({
  summary: `${name}, one of the main characters.`, voice: "Plain and brief.", goals: "See this through, together", riskTolerance: "balanced",
});
const blankNpc = (name: string): NpcDraft => ({
  summary: `${name}.`, voice: "Plain and brief.", knowledge: "", wants: "", agenda: false, everyMinutes: 10, aims: "",
});

/**
 * Who the agents are and which models play them. Each main character with a
 * persona is played by its own agent; one without never takes turns.
 * Supporting characters are voiced by the game master's model, and one
 * without a persona never speaks.
 */
export function SetupEditor({ worldId, view, onSaved }: { worldId: string; view: WorldView; onSaved(view: WorldView): void }) {
  const [draft, setDraft] = useState(() => draftOf(view));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const state = view.world;

  function change(update: (draft: Draft) => Draft) {
    setDraft(update);
    setDirty(true);
    setSaved(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveSetup(worldId, setupOf(draft));
      onSaved(next);
      setDraft(draftOf(next));
      setDirty(false);
      setSaved(true);
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack setup" onSubmit={(event) => void save(event)}>
      <p className="muted small">
        {view.setupSaved ? "Saved for this world." : "Not saved yet: these are the bundled story's defaults."} Changes apply from the next turn.
      </p>

      <h3>Models</h3>
      <ModelField label="Characters" hint="Plays each main character's agent"
        value={draft.models.character} resolved={view.models.character} effort={draft.models.characterEffort}
        onChange={(model, effort) => change((current) => ({ ...current, models: withModel(current.models, "character", model, effort) }))} />
      <ModelField label="Game master" hint="Referees attempts, narrates, and voices supporting characters"
        value={draft.models.dm} resolved={view.models.dm} effort={draft.models.dmEffort}
        onChange={(model, effort) => change((current) => ({ ...current, models: withModel(current.models, "dm", model, effort) }))} />

      <h3>The world</h3>
      <label className="field">
        Premise
        <textarea rows={4} maxLength={1000} value={draft.premise} placeholder="Setting, genre, tone, and what is at stake, in two to four sentences."
          onChange={(event) => { const premise = event.target.value; change((current) => ({ ...current, premise })); }} />
        <span className="field-hint">Every AI reads this, the main characters included: keep secrets out of it.</span>
      </label>
      <label className="field">
        How the narrator writes
        <textarea rows={2} maxLength={500} value={draft.narratorStyle}
          onChange={(event) => { const narratorStyle = event.target.value; change((current) => ({ ...current, narratorStyle })); }} />
      </label>
      <label className="inline">
        Pace{" "}
        <select value={draft.pace} onChange={(event) => { const pace = event.target.value as Pace; change((current) => ({ ...current, pace })); }}>
          <option value="action">action: a group that only talks is pressed to act</option>
          <option value="conversation">conversation: talk can carry the scene</option>
        </select>
      </label>

      <h3>Main characters</h3>
      {state.characters.filter((character) => !character.npc).map((character) => {
        const persona = draft.characters[character.id] ?? null;
        const set = (next: PersonaDraft | null) => change((current) => ({ ...current, characters: { ...current.characters, [character.id]: next } }));
        return (
          <fieldset key={character.id} className="sheet">
            <legend className="row">
              <strong>{character.name}</strong>
              <label className="inline small">
                <input type="checkbox" checked={persona !== null} onChange={(event) => set(event.target.checked ? blankPersona(character.name) : null)} />{" "}
                an agent plays this character
              </label>
            </legend>
            {persona && (
              <>
                <label className="field">Who they are<textarea rows={2} maxLength={500} value={persona.summary} onChange={(event) => set({ ...persona, summary: event.target.value })} /></label>
                <label className="field">How they speak<input maxLength={500} value={persona.voice} onChange={(event) => set({ ...persona, voice: event.target.value })} /></label>
                <label className="field">What they want <span className="muted small">(one per line, up to 8)</span>
                  <textarea rows={3} value={persona.goals} onChange={(event) => set({ ...persona, goals: event.target.value })} />
                </label>
                <label className="inline">
                  Attitude to risk{" "}
                  <select value={persona.riskTolerance} onChange={(event) => set({ ...persona, riskTolerance: event.target.value as Persona["riskTolerance"] })}>
                    <option value="cautious">cautious</option>
                    <option value="balanced">balanced</option>
                    <option value="bold">bold</option>
                  </select>
                </label>
              </>
            )}
          </fieldset>
        );
      })}

      {state.characters.some((character) => character.npc) && <h3>Supporting characters</h3>}
      {state.characters.filter((character) => character.npc).map((character) => {
        const persona = draft.npcs[character.id] ?? null;
        const set = (next: NpcDraft | null) => change((current) => ({ ...current, npcs: { ...current.npcs, [character.id]: next } }));
        return (
          <fieldset key={character.id} className="sheet">
            <legend className="row">
              <strong>{character.name}</strong>
              <label className="inline small">
                <input type="checkbox" checked={persona !== null} onChange={(event) => set(event.target.checked ? blankNpc(character.name) : null)} />{" "}
                the game master voices them
              </label>
            </legend>
            {persona && (
              <>
                <label className="field">Who they are<textarea rows={2} maxLength={500} value={persona.summary} onChange={(event) => set({ ...persona, summary: event.target.value })} /></label>
                <label className="field">How they speak<input maxLength={500} value={persona.voice} onChange={(event) => set({ ...persona, voice: event.target.value })} /></label>
                <label className="field">What they know or believe <span className="muted small">(one per line; it may be wrong)</span>
                  <textarea rows={3} value={persona.knowledge} onChange={(event) => set({ ...persona, knowledge: event.target.value })} />
                </label>
                <label className="field">What they want <span className="muted small">(one per line)</span>
                  <textarea rows={2} value={persona.wants} onChange={(event) => set({ ...persona, wants: event.target.value })} />
                </label>
                <label className="inline small">
                  <input type="checkbox" checked={persona.agenda} onChange={(event) => set({ ...persona, agenda: event.target.checked })} />{" "}
                  speaks up unprompted, at most every{" "}
                  <input type="number" min={1} max={1440} value={persona.everyMinutes} disabled={!persona.agenda}
                    onChange={(event) => set({ ...persona, everyMinutes: Number(event.target.value) })} />{" "}
                  in-world minutes, when main characters are there
                </label>
                {persona.agenda && (
                  <label className="field">To what end <span className="muted small">(one per line)</span>
                    <textarea rows={2} value={persona.aims} onChange={(event) => set({ ...persona, aims: event.target.value })} />
                  </label>
                )}
              </>
            )}
          </fieldset>
        );
      })}

      <TheirPrompts worldId={worldId} view={view} />

      <div className="row sticky-actions">
        <button type="submit" className="primary" disabled={busy || (!dirty && view.setupSaved)}>{view.setupSaved ? "Save" : "Save for this world"}</button>
        {dirty && <button type="button" onClick={() => { setDraft(draftOf(view)); setDirty(false); }}>Discard changes</button>}
        {saved && <span className="muted small">Saved.</span>}
        {error && <span className="error small">{error}</span>}
      </div>
    </form>
  );
}

/** The system prompts the narrator and the referee are sent, as saved. Characters' are in each one's inspector. */
function TheirPrompts({ worldId, view }: { worldId: string; view: WorldView }) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<{ narrator: string; referee: string; judge?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = view.world.revision;
  const setup = view.setup;
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.prompts(worldId)
      .then((next) => { if (current) { setPrompts(next); setError(null); } })
      .catch((problem) => { if (current) setError(errorText(problem)); });
    return () => { current = false; };
  }, [open, worldId, revision, setup]);
  return (
    <details className="sheet" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><strong>What each AI is told</strong> <span className="muted small">· the saved setup's system prompts</span></summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <p className="muted small">Each main character's prompt is in their inspector, under Cast: choose a character, then "What its agent is sent".</p>
        {error && <p className="error small">{error}</p>}
        {!prompts && !error && <p className="muted small">Loading…</p>}
        {prompts && (
          <>
            <h4>Narrator</h4>
            <pre className="prompt">{prompts.narrator}</pre>
            <h4>Referee, for open-ended actions</h4>
            <pre className="prompt">{prompts.referee}</pre>
            {prompts.judge && (
              <>
                <h4>Referee, judging attempts at challenges</h4>
                <pre className="prompt">{prompts.judge}</pre>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function withModel(models: ModelSetup, role: "character" | "dm", model: string | undefined, effort: string | undefined): ModelSetup {
  const next: ModelSetup = { ...models };
  const effortKey = role === "character" ? "characterEffort" : "dmEffort";
  if (model) next[role] = model;
  else delete next[role];
  if (effort) next[effortKey] = effort as NonNullable<ModelSetup["characterEffort"]>;
  else delete next[effortKey];
  return next;
}

/** A model ID, searchable among OpenRouter's models, with its reasoning effort when it has one. */
function ModelField({ label, hint, value, resolved, effort, onChange }: {
  label: string;
  hint: string;
  value: string | undefined;
  resolved: string;
  effort: string | undefined;
  onChange(model: string | undefined, effort: string | undefined): void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<ModelInfo[] | null>(null);
  const [chosen, setChosen] = useState<ModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = setTimeout(() => {
      api.models(query)
        .then((models) => { if (current) { setResults(models); setError(null); } })
        .catch((problem) => { if (current) setError(errorText(problem)); });
    }, query.trim() ? 250 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const known = [...(results ?? []), ...(chosen ? [chosen] : [])];
  const efforts = known.find((model) => model.id === (value ?? resolved))?.efforts ?? null;
  const dollars = (amount: number | null) => (amount === null ? "?" : `$${Number(amount.toFixed(4))}`);
  const price = (model: ModelInfo) => (model.promptPerMillion === null ? "" : ` · ${dollars(model.promptPerMillion)}/${dollars(model.completionPerMillion)} per M tokens`);
  const pick = (model: ModelInfo | null) => {
    setChosen(model);
    setOpen(false);
    setQuery("");
    onChange(model?.id, effort);
  };
  return (
    <div className="field model-field">
      <div className="row">
        <strong>{label}</strong>
        <span className="muted small grow">{hint}</span>
      </div>
      <div className="combo" ref={box}>
        <button type="button" className="combo-button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label} model`}
          onClick={() => setOpen((was) => !was)}>
          {value ?? `${resolved} (default)`}
        </button>
        {open && (
          <div className="combo-panel">
            <input value={query} onChange={(event) => setQuery(event.target.value)} autoFocus
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } }}
              placeholder="Search OpenRouter models, e.g. claude sonnet" aria-label={`Search ${label} models`} />
            <ul className="model-results small" role="listbox">
              <li>
                <button type="button" className="link" onClick={() => pick(null)}>{resolved} (default)</button>
              </li>
              {results === null && !error && <li className="muted">Loading…</li>}
              {results?.length === 0 && <li className="muted">No models match.</li>}
              {results?.map((model) => (
                <li key={model.id}>
                  <button type="button" className="link" disabled={model.output === "text"} role="option" aria-selected={model.id === value}
                    title={model.output === "text" ? "This model cannot return JSON, which every agent needs" : undefined}
                    onClick={() => pick(model)}>
                    {model.id}
                  </button>
                  <span className="muted">
                    {price(model)}{model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k context` : ""}
                    {model.reasoning && " · reasoning"}{model.output === "text" && " · no JSON output"}
                  </span>
                </li>
              ))}
            </ul>
            {error && <p className="error small">{error}</p>}
          </div>
        )}
      </div>
      <label className="inline small">
        effort{" "}
        <select value={effort ?? ""} onChange={(event) => onChange(value, event.target.value || undefined)}>
          <option value="">from environment</option>
          <option value="default">model default</option>
          {(efforts ?? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]).map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
    </div>
  );
}
