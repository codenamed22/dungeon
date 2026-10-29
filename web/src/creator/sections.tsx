import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AlertTriangle, ChevronDown, CircleAlert, Plus, Sparkles, Trash2, X } from "lucide-react";
import {
  bandOf, connectPlaces, disconnectPlaces, remove, setPersona, setWorld, upsertChallenge, upsertCharacter, upsertEnding, upsertItem,
  upsertPlace, upsertThreat,
} from "../../../src/creator/operations.ts";
import type { OperationResult, removeKinds } from "../../../src/creator/operations.ts";
import { rulesOf } from "../../../src/model.ts";
import type { Draft, DraftSection } from "../types.ts";
import { Field, LiveText, Segmented, Stepper } from "../ui/controls.tsx";
import { refusal } from "./useDraft.ts";
import type { DraftEditor } from "./useDraft.ts";

type Seed = Draft["seed"];
type Location = Seed["locations"][number];
type Character = Seed["characters"][number];
type Challenge = Seed["challenges"][number];
type Threat = NonNullable<Seed["threats"]>[number];
type Ending = NonNullable<Seed["endings"]>[number];
type Edit = (draft: Draft) => OperationResult;
type Ability = Challenge["ability"];
type Band = "easy" | "moderate" | "hard" | "very hard";

const ABILITIES: readonly Ability[] = ["strength", "dexterity", "wisdom"];
const ROLES: readonly { value: "party" | "npc"; label: string }[] = [{ value: "party", label: "Main" }, { value: "npc", label: "Supporting" }];
const DEFAULT_STATS = ["Strength", "Dexterity", "Wisdom"];
const BANDS: readonly { value: Band; label: string }[] = [
  { value: "easy", label: "Easy" }, { value: "moderate", label: "Moderate" }, { value: "hard", label: "Hard" }, { value: "very hard", label: "Very hard" },
];

/** What every section needs: the editor, the card to show (from Review), and a way to offer Undo. */
export interface SectionProps {
  editor: DraftEditor;
  draft: Draft;
  focus: { id: string; nonce: number } | null;
  onToast(message: string, undo?: Draft): void;
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

function nameIn(seed: Seed, id: string): string {
  return [...seed.locations, ...seed.items, ...seed.characters, ...seed.challenges, ...seed.threats ?? [], ...seed.endings ?? []]
    .find((entity) => entity.id === id)?.name ?? id;
}

/** The three stats under the world's own names, or null when it has none. */
function statOptions(seed: Seed): { value: Ability; label: string }[] | null {
  const { stats } = rulesOf(seed);
  return stats && ABILITIES.map((ability) => ({ value: ability, label: stats[ability] }));
}

/** What the world calls health in a label: "Hit points" for HP. */
const healthLabel = (health: string) => (health === "HP" ? "Hit points" : health);

/** Every way between places, for choosing which a challenge or threat changes. */
function allRoutes(seed: Seed) {
  return seed.locations.flatMap((location) => location.routes.map((route) => ({
    key: `${location.id}>${route.destinationId}`,
    fromId: location.id,
    toId: route.destinationId,
    locked: route.locked === true,
    label: `${location.name} → ${nameIn(seed, route.destinationId)}`,
  })));
}

/** The card to open: one just added, or one Review pointed at. */
function useOpenCard(focus: SectionProps["focus"]) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen(focus.id);
    requestAnimationFrame(() => {
      const card = document.getElementById(`card-${focus.id}`);
      card?.scrollIntoView({ block: "center", behavior: "smooth" });
      card?.classList.remove("highlight");
      void card?.offsetWidth;
      card?.classList.add("highlight");
    });
  }, [focus]);
  return { open, toggle: (id: string) => setOpen((current) => (current === id ? null : id)), show: setOpen };
}

/** Finds what an operation added, so its card can open. */
function added(before: Draft, after: Draft, key: "locations" | "items" | "characters" | "challenges" | "threats" | "endings"): string | undefined {
  const known = new Set((before.seed[key] ?? []).map((entity) => entity.id));
  return (after.seed[key] ?? []).find((entity) => !known.has(entity.id))?.id;
}

function CardEditor({ id, number, kind, title, subtitle, open, onToggle, flagged, children }: {
  id: string;
  number: ReactNode;
  kind?: string | undefined;
  title: string;
  subtitle?: ReactNode;
  open: boolean;
  onToggle(): void;
  flagged?: boolean;
  children: ReactNode;
}) {
  return (
    <div id={`card-${id}`} className={`card-editor ${open ? "open" : ""} ${flagged ? "flagged" : ""}`}>
      <button type="button" className="card-summary" aria-expanded={open} onClick={onToggle}>
        <span className={`number ${kind ?? ""}`}>{number}</span>
        <span className="summary-text"><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</span>
        <ChevronDown size={17} className="muted" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && <div className="card-fields">{children}</div>}
    </div>
  );
}

function AddRow({ placeholder, label, onAdd, disabled, hint, children }: {
  placeholder: string;
  label: string;
  onAdd(name: string): string | null;
  disabled?: boolean;
  hint?: string;
  children?: ReactNode;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = onAdd(name.trim());
    setError(problem);
    if (!problem) setName("");
  }
  return (
    <>
      <form className="add-row wrap" onSubmit={submit}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={placeholder} aria-label={label} maxLength={100} disabled={disabled} />
        {children}
        <button type="submit" className="primary" disabled={disabled || !name.trim()}><Plus size={16} />Add</button>
      </form>
      {(error || (disabled && hint)) && <p className={error ? "field-error" : "field-hint"} style={{ marginTop: -6 }}>{error ?? hint}</p>}
    </>
  );
}

function RemoveButton({ label, onRemove }: { label: string; onRemove(): void }) {
  return <button type="button" className="text-button danger-text" onClick={onRemove}><Trash2 size={14} />Remove {label}</button>;
}

/** Toggle chips over a list of choices. */
function ChipChoice<T extends string>({ options, chosen, onChange, empty }: {
  options: readonly { value: T; label: string }[];
  chosen: readonly T[];
  onChange(next: T[]): void;
  empty?: string;
}) {
  if (options.length === 0) return <span className="field-hint">{empty}</span>;
  return (
    <div className="chips">
      {options.map((option) => {
        const on = chosen.includes(option.value);
        return (
          <button key={option.value} type="button" className="chip" aria-pressed={on}
            onClick={() => onChange(on ? chosen.filter((value) => value !== option.value) : [...chosen, option.value])}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function useRemove({ editor, draft, onToast }: SectionProps) {
  return (kind: (typeof removeKinds)[number], id: string) => {
    const outcome = editor.apply((current) => remove(current, { kind, id }));
    if (typeof outcome === "string") onToast(outcome);
    else onToast(outcome.summary, draft);
  };
}

// ---------------------------------------------------------------------------

export function StorySection({ editor, draft, onToast }: SectionProps) {
  const { seed, cast } = draft;
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  const rulings = seed.rulings;
  const rules = rulesOf(seed);
  const stats = statOptions(seed);
  /** A rules change may clear stats or damage, so it says what changed, with Undo. */
  const applyRules = (edit: Edit) => {
    const outcome = editor.apply(edit);
    if (typeof outcome === "string") onToast(outcome);
    else if (/cleared|removed/.test(outcome.summary)) onToast(outcome.summary, draft);
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <LiveText label="Title" value={seed.name} maxLength={100} commit={(name) => apply((current) => setWorld(current, { name }))} />
      <LiveText label="Premise" multiline rows={4} maxLength={1000} value={cast.premise ?? ""}
        placeholder="e.g. A payments company at 3 a.m. Checkout is down, and two engineers on call have an hour before morning traffic."
        hint={<>Setting, genre, tone, and what is at stake, in two to four sentences. <strong>Every AI reads it, the main characters included</strong>, so keep secrets and solutions out of it.</>}
        commit={(premise) => apply((current) => setWorld(current, { premise }))} />
      <LiveText label="How the narrator writes" multiline rows={2} maxLength={500} value={cast.narratorStyle}
        hint="e.g. Warm and observant, present tense." commit={(narratorStyle) => apply((current) => setWorld(current, { narratorStyle }))} />
      <div className="card-fields" style={{ border: 0, padding: 0 }}>
        <section className="group" aria-labelledby="rules-title">
          <h3 id="rules-title" className="eyebrow">Rules</h3>
          <Field label="How attempts are decided"
            hint={rules.outcomes === "judgment"
              ? "A referee AI decides each attempt from what the challenge says it takes. Suits social, investigative, and technical stories."
              : "A d20 roll plus a stat against each challenge's difficulty. Suits perilous stories where luck should matter."}>
            <Segmented label="How attempts are decided" value={rules.outcomes}
              options={[{ value: "judgment", label: "AI judgment" }, { value: "dice", label: "Dice" }]}
              onChange={(outcomes) => applyRules((current) => setWorld(current, { outcomes }))} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={stats !== null}
              onChange={(event) => applyRules((current) => setWorld(current, { statNames: event.target.checked ? DEFAULT_STATS : null }))} />
            Characters have stats
          </label>
          {stats ? (
            <div className="form-grid three">
              {stats.map((stat, index) => (
                <LiveText key={stat.value} label={`Stat ${index + 1}`} value={stat.label} maxLength={30}
                  commit={(name) => apply((current) => setWorld(current, { statNames: stats.map((entry, at) => (at === index ? name : entry.label)) }))} />
              ))}
            </div>
          ) : <span className="field-hint">Without stats, nobody is better at anything by number; the referee goes by what they do.</span>}
          <label className="checkbox">
            <input type="checkbox" checked={rules.health !== null}
              onChange={(event) => applyRules((current) => setWorld(current, { healthName: event.target.checked ? "HP" : null }))} />
            Characters have health, and can be hurt
          </label>
          {rules.health !== null ? (
            <LiveText label="What health is called" value={rules.health} maxLength={30} hint="e.g. HP, Composure, or Morale. At 0, a character is out of the story."
              commit={(healthName) => apply((current) => setWorld(current, { healthName }))} />
          ) : <span className="field-hint">Without health, nothing can deal damage and nobody is taken out.</span>}
          <Field label="Pace"
            hint={(cast.pace ?? "action") === "action"
              ? "A group that only talks is nudged, then made to act. Suits stories driven by doing."
              : "Talk can carry the scene; a long stretch of it only gets a nudge to move on. Suits dates, interviews, and mysteries."}>
            <Segmented label="Pace" value={cast.pace ?? "action"}
              options={[{ value: "action", label: "Action" }, { value: "conversation", label: "Conversation" }]}
              onChange={(pace) => apply((current) => setWorld(current, { pace }))} />
          </Field>
        </section>
      </div>
      <Field label="In-world seconds one spoken line takes">
        <Stepper label="seconds per line" value={seed.speechSeconds} min={1} max={600} unit="s"
          onChange={(secondsPerLine) => apply((current) => setWorld(current, { secondsPerLine }))} />
      </Field>
      <div className="card-fields" style={{ border: 0, padding: 0 }}>
        <div className="group">
          <label className="checkbox">
            <input type="checkbox" checked={rulings !== undefined}
              onChange={(event) => apply((current) => setWorld(current, { openEndedActions: event.target.checked }))} />
            Characters may try things no challenge covers
          </label>
          <span className="field-hint">
            {rules.outcomes === "judgment" ? "A referee AI rules on each such attempt and decides whether it works" : "A referee AI sets a check for each such attempt"}, within
            these limits. Without them, characters can only use the challenges you write.
          </span>
          {rulings && (
            <>
              {stats && (
                <Field label="Stats it may test">
                  <ChipChoice options={stats} chosen={rulings.abilities}
                    onChange={(next) => (next.length > 0 ? apply((current) => setWorld(current, { rulingAbilities: next })) : null)} />
                </Field>
              )}
              <Field label="The hardest check it may set">
                <Segmented label="Hardest check" options={BANDS} value={rulings.maxDifficulty}
                  onChange={(rulingMaxDifficulty) => apply((current) => setWorld(current, { rulingMaxDifficulty }))} />
              </Field>
              <div className="form-grid">
                {rules.health !== null && (
                  <Field label={`Most ${rules.health === "HP" ? "damage" : rules.health} a failure costs`}>
                    <Stepper label="most damage" value={rulings.maxFailureDamage} min={0} max={100}
                      onChange={(rulingMaxDamage) => apply((current) => setWorld(current, { rulingMaxDamage }))} />
                  </Field>
                )}
                <Field label="Longest an attempt takes">
                  <Stepper label="longest attempt" value={minutes(rulings.maxSeconds)} min={1} max={60} unit="min"
                    onChange={(rulingMaxMinutes) => apply((current) => setWorld(current, { rulingMaxMinutes }))} />
                </Field>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PlacesSection(props: SectionProps) {
  const { editor, draft, focus } = props;
  const { seed } = draft;
  const cards = useOpenCard(focus);
  const removeEntity = useRemove(props);
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  return (
    <>
      <AddRow label="New place" placeholder="Add a place, e.g. The kitchen" onAdd={(name) => {
        const outcome = editor.apply((current) => upsertPlace(current, { name }));
        if (typeof outcome === "string") return outcome;
        const id = added(draft, outcome.draft, "locations");
        if (id) cards.show(id);
        return null;
      }} />
      {seed.locations.length === 0 && <p className="muted">No places yet. Every world needs at least one: the main characters start there.</p>}
      <div className="editor-list">
        {seed.locations.map((location, index) => {
          const here = seed.characters.filter((character) => character.locationId === location.id);
          const ways = location.routes.length;
          return (
            <CardEditor key={location.id} id={location.id} number={index + 1} title={location.name}
              subtitle={`${ways} way${ways === 1 ? "" : "s"} out${here.length ? ` · ${here.map((character) => character.name).join(", ")} start here` : ""}`}
              open={cards.open === location.id} onToggle={() => cards.toggle(location.id)}>
              <LiveText label="Name" value={location.name} maxLength={100} commit={(name) => apply((current) => upsertPlace(current, { id: location.id, name }))} />
              <LiveText label="What anyone there sees" multiline rows={2} maxLength={1000} value={location.description ?? ""}
                hint="No secrets: hide those in challenges, discoveries, and what supporting characters know."
                commit={(description) => apply((current) => upsertPlace(current, { id: location.id, description }))} />
              <div className="group">
                <span className="eyebrow">Ways out</span>
                {location.routes.length === 0 && <span className="field-hint">None yet. Without a way out, nobody can leave.</span>}
                {location.routes.map((route) => {
                  const back = seed.locations.find((entry) => entry.id === route.destinationId)?.routes.some((entry) => entry.destinationId === location.id);
                  return (
                    <div key={route.destinationId} className="exit-row">
                      <span>→ {nameIn(seed, route.destinationId)}{back ? "" : <span className="muted small"> (one way)</span>}</span>
                      <Stepper label={`minutes to ${nameIn(seed, route.destinationId)}`} value={minutes(route.seconds)} min={1} max={1440} unit="min"
                        onChange={(next) => apply((current) => connectPlaces(current, { fromId: location.id, toId: route.destinationId, minutes: next, bothWays: back === true }))} />
                      <label className="checkbox small" title="Blocked until a challenge or threat opens it; only this direction">
                        <input type="checkbox" checked={route.locked === true}
                          onChange={(event) => apply((current) => connectPlaces(current, { fromId: location.id, toId: route.destinationId, minutes: minutes(route.seconds), locked: event.target.checked, bothWays: false }))} />
                        blocked
                      </label>
                      <button type="button" className="icon-button" aria-label={`Remove the way to ${nameIn(seed, route.destinationId)}`} title="Remove this way"
                        onClick={() => apply((current) => disconnectPlaces(current, { fromId: location.id, toId: route.destinationId, bothWays: false }))}>
                        <X size={16} />
                      </button>
                    </div>
                  );
                })}
                <AddWay location={location} places={seed.locations} onAdd={(toId, next, bothWays) => apply((current) => connectPlaces(current, { fromId: location.id, toId, minutes: next, bothWays }))} />
              </div>
              <div className="card-actions">
                <span className="muted small">ID {location.id}</span>
                <RemoveButton label="place" onRemove={() => removeEntity("place", location.id)} />
              </div>
            </CardEditor>
          );
        })}
      </div>
    </>
  );
}

function AddWay({ location, places, onAdd }: { location: Location; places: readonly Location[]; onAdd(toId: string, minutes: number, bothWays: boolean): string | null }) {
  const choices = places.filter((place) => place.id !== location.id && !location.routes.some((route) => route.destinationId === place.id));
  const [toId, setToId] = useState("");
  const [time, setTime] = useState(5);
  const [bothWays, setBothWays] = useState(true);
  const [error, setError] = useState<string | null>(null);
  if (choices.length === 0) return places.length < 2 ? <span className="field-hint">Add another place to make a way to it.</span> : null;
  const target = choices.some((place) => place.id === toId) ? toId : choices[0]!.id;
  return (
    <>
      <div className="exit-row">
        <select value={target} onChange={(event) => setToId(event.target.value)} aria-label="Way to">
          {choices.map((place) => <option key={place.id} value={place.id}>→ {place.name}</option>)}
        </select>
        <Stepper label="minutes for the new way" value={time} min={1} max={1440} unit="min" onChange={setTime} />
        <label className="checkbox small"><input type="checkbox" checked={bothWays} onChange={(event) => setBothWays(event.target.checked)} />both ways</label>
        <button type="button" onClick={() => setError(onAdd(target, time, bothWays))}><Plus size={15} />Add way</button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------

export function CharactersSection(props: SectionProps) {
  const { editor, draft, focus } = props;
  const { seed } = draft;
  const cards = useOpenCard(focus);
  const removeEntity = useRemove(props);
  const [role, setRole] = useState<"party" | "npc">("party");
  const firstPlace = seed.locations[0]?.id;
  const party = seed.characters.filter((character) => !character.npc);
  const npcs = seed.characters.filter((character) => character.npc);
  const card = (character: Character, index: number) => (
    <CharacterCard key={character.id} {...props} character={character} number={index + 1}
      open={cards.open === character.id} onToggle={() => cards.toggle(character.id)}
      onRemove={() => removeEntity("character", character.id)} />
  );
  return (
    <>
      <AddRow label="New character" placeholder={role === "party" ? "Add a main character, e.g. Priya" : "Add a supporting character, e.g. Mrs. Hale"}
        disabled={!firstPlace} hint="Add a place first: everyone starts somewhere."
        onAdd={(name) => {
          const outcome = editor.apply((current) => upsertCharacter(current, { name, placeId: firstPlace!, npc: role === "npc" }));
          if (typeof outcome === "string") return outcome;
          const id = added(draft, outcome.draft, "characters");
          if (id) cards.show(id);
          return null;
        }}>
        <Segmented label="Role" value={role} onChange={(next) => setRole(next)} options={ROLES} />
      </AddRow>
      <h3>Main characters <span className="muted small">· each played by its own AI agent</span></h3>
      {party.length === 0 && <p className="muted small">No main characters yet. A world needs at least one.</p>}
      <div className="editor-list">{party.map(card)}</div>
      <h3>Supporting characters <span className="muted small">· voiced by the game master</span></h3>
      {npcs.length === 0 && <p className="muted small">None yet. They are optional, but someone who knows something (and is partly wrong) makes a world richer.</p>}
      <div className="editor-list">{npcs.map(card)}</div>
    </>
  );
}

function CharacterCard({ editor, draft, onToast, character, number, open, onToggle, onRemove }: SectionProps & {
  character: Character;
  number: number;
  open: boolean;
  onToggle(): void;
  onRemove(): void;
}) {
  const { seed, cast } = draft;
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  const id = character.id;
  const npc = character.npc === true;
  const persona = npc ? cast.npcs?.[id] : cast.characters[id];
  const placeKnown = seed.locations.some((location) => location.id === character.locationId);
  const carried = Object.entries(character.inventory).flatMap(([itemId, count]) => Array.from({ length: count }, () => itemId));
  const { health } = rulesOf(seed);
  const stats = statOptions(seed);
  const away = character.away === true;
  const subtitle = [
    placeKnown ? `${away ? "starts away, appears at" : "starts in"} ${nameIn(seed, character.locationId)}` : "starts nowhere",
    health === null ? null : `${character.maxHp} ${health}`,
    persona ? null : npc ? "never speaks" : "no agent plays them",
  ].filter(Boolean).join(" · ");
  return (
    <CardEditor id={id} number={number} kind={npc ? "npc" : undefined} title={character.name} subtitle={subtitle}
      open={open} onToggle={onToggle} flagged={!placeKnown}>
      <div className="form-grid">
        <LiveText label="Name" value={character.name} maxLength={100} commit={(name) => apply((current) => upsertCharacter(current, { id, name }))} />
        <Field label={away ? "Appears at" : "Starts in"}>
          <select value={character.locationId} onChange={(event) => apply((current) => upsertCharacter(current, { id, placeId: event.target.value }))}>
            {!placeKnown && <option value={character.locationId}>(choose a place)</option>}
            {seed.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="At the start" hint={away ? "Away until a threat brings them in, someone calls or fetches them, or you bring them in as director." : undefined}>
        <Segmented label="At the start" value={away ? "away" : "here"} options={[{ value: "here", label: "In the scene" }, { value: "away", label: "Away" }]}
          onChange={(next) => apply((current) => upsertCharacter(current, { id, startsAway: next === "away" }))} />
      </Field>
      <Field label="Role" hint={persona ? "Changing the role removes the persona, since main and supporting characters have different ones." : undefined}>
        <Segmented label="Role" value={npc ? "npc" : "party"} options={[{ value: "party", label: "Main character" }, { value: "npc", label: "Supporting" }]}
          onChange={(next) => {
            if ((next === "npc") === npc) return;
            const outcome = editor.apply((current) => upsertCharacter(current, { id, npc: next === "npc" }));
            if (typeof outcome !== "string" && persona) onToast(`${character.name} is now ${next === "npc" ? "a supporting" : "a main"} character, without a persona.`, draft);
          }} />
      </Field>
      {health !== null && (
        <div className="form-grid three">
          <Field label={healthLabel(health)}>
            <Stepper label={healthLabel(health)} value={character.maxHp} min={1} max={100} onChange={(maxHp) => apply((current) => upsertCharacter(current, { id, maxHp, hp: maxHp }))} />
          </Field>
        </div>
      )}
      {stats && (
        <div className="form-grid three">
          {stats.map((stat) => (
            <Field key={stat.value} label={stat.label} hint={stat.value === "strength" ? "0 average, 3 strong, 5 exceptional" : undefined}>
              <Stepper label={stat.label} value={character.modifiers[stat.value]} min={-5} max={10}
                onChange={(value) => apply((current) => upsertCharacter(current, { id, [stat.value]: value }))} />
            </Field>
          ))}
        </div>
      )}
      <Field label="Carries">
        <div className="chips">
          {Object.entries(character.inventory).map(([itemId, count]) => (
            <span key={itemId} className="chip">
              {nameIn(seed, itemId)}{count > 1 ? ` ×${count}` : ""}
              <button type="button" className="remove" aria-label={`Take ${nameIn(seed, itemId)} away`}
                onClick={() => {
                  const index = carried.indexOf(itemId);
                  apply((current) => upsertCharacter(current, { id, itemIds: carried.filter((_, at) => at !== index) }));
                }}><X size={12} /></button>
            </span>
          ))}
          {seed.items.length > 0 ? (
            <select value="" aria-label="Give an item" style={{ width: "auto" }}
              onChange={(event) => event.target.value && apply((current) => upsertCharacter(current, { id, itemIds: [...carried, event.target.value] }))}>
              <option value="">Give an item…</option>
              {seed.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          ) : <span className="field-hint">Add items in the Items section to hand them out.</span>}
        </div>
      </Field>
      <PersonaEditor editor={editor} character={character} persona={persona} />
      <div className="card-actions">
        <span className="muted small">ID {id}</span>
        <RemoveButton label={npc ? "supporting character" : "main character"} onRemove={onRemove} />
      </div>
    </CardEditor>
  );
}

type PartyPersona = Draft["cast"]["characters"][string];
type NpcPersona = NonNullable<Draft["cast"]["npcs"]>[string];

function PersonaEditor({ editor, character, persona }: { editor: DraftEditor; character: Character; persona: PartyPersona | NpcPersona | undefined }) {
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  const characterId = character.id;
  const npc = character.npc === true;
  if (!persona) {
    return (
      <div className="persona">
        <span className="eyebrow">Persona</span>
        <span className="field-hint">
          {npc ? "Without a persona, the game master never voices this character." : "Without a persona, no agent plays this character, so they never take a turn."}
        </span>
        <div>
          <button type="button" onClick={() => apply((current) => setPersona(current, npc
            ? { characterId, summary: `${character.name}.`, voice: "Natural and conversational." }
            : { characterId, summary: `${character.name}, one of the main characters.`, voice: "Natural and conversational.", goals: ["See this through, together"] }))}>
            <Sparkles size={15} />Write a persona
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="persona">
      <span className="eyebrow">Persona: what the AI {npc ? "voicing" : "playing"} {character.name} is told</span>
      <LiveText label="Who they are" multiline rows={2} maxLength={500} value={persona.summary}
        commit={(summary) => apply((current) => setPersona(current, { characterId, summary }))} />
      <LiveText label="Who they are to the others" maxLength={300} value={persona.knownAs ?? ""} placeholder="e.g. the incident commander tonight" hint="Every AI reads this, so the characters know who they are talking to. No secrets."
        commit={(knownAs) => apply((current) => setPersona(current, { characterId, knownAs }))} />
      <LiveText label="How they speak" maxLength={500} value={persona.voice} commit={(voice) => apply((current) => setPersona(current, { characterId, voice }))} />
      {"goals" in persona ? (
        <>
          <LiveText label="What they want" multiline rows={3} value={persona.goals.join("\n")} hint="One per line, up to 8."
            commit={(text) => apply((current) => setPersona(current, { characterId, goals: lines(text) }))} />
          <Field label="Attitude to risk">
            <Segmented label="Attitude to risk" value={persona.riskTolerance}
              options={[{ value: "cautious", label: "Cautious" }, { value: "balanced", label: "Balanced" }, { value: "bold", label: "Bold" }]}
              onChange={(riskTolerance) => apply((current) => setPersona(current, { characterId, riskTolerance }))} />
          </Field>
        </>
      ) : (
        <>
          <LiveText label="What they know or believe" multiline rows={3} value={persona.knowledge.join("\n")}
            hint="One per line. It may be wrong: that is how rumors work."
            commit={(text) => apply((current) => setPersona(current, { characterId, knowledge: lines(text) }))} />
          <LiveText label="What they want" multiline rows={2} value={persona.wants.join("\n")} hint="One per line."
            commit={(text) => apply((current) => setPersona(current, { characterId, wants: lines(text) }))} />
          <label className="checkbox">
            <input type="checkbox" checked={persona.agenda !== undefined}
              onChange={(event) => apply((current) => setPersona(current, event.target.checked
                ? { characterId, agendaAims: ["Bring up what they want"], agendaEveryMinutes: 10 }
                : { characterId, agendaAims: [] }))} />
            Speaks up unprompted when main characters are there
          </label>
          {persona.agenda && (
            <>
              <Field label="At most every">
                <Stepper label="minutes between remarks" value={persona.agenda.everyMinutes} min={1} max={1440} unit="min"
                  onChange={(agendaEveryMinutes) => apply((current) => setPersona(current, { characterId, agendaEveryMinutes }))} />
              </Field>
              <LiveText label="To what end" multiline rows={2} value={persona.agenda.aims.join("\n")} hint="One per line."
                commit={(text) => apply((current) => setPersona(current, { characterId, agendaAims: lines(text) }))} />
            </>
          )}
        </>
      )}
      <div><button type="button" className="text-button danger-text" onClick={() => apply((current) => remove(current, { kind: "persona", id: characterId }))}>Remove persona</button></div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ItemsSection(props: SectionProps) {
  const { editor, draft, focus } = props;
  const { seed } = draft;
  const cards = useOpenCard(focus);
  const removeEntity = useRemove(props);
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  return (
    <>
      <AddRow label="New item" placeholder="Add an item, e.g. A spare key" onAdd={(name) => {
        const outcome = editor.apply((current) => upsertItem(current, { name }));
        if (typeof outcome === "string") return outcome;
        const id = added(draft, outcome.draft, "items");
        if (id) cards.show(id);
        return null;
      }} />
      {seed.items.length === 0 && <p className="muted">No items. Challenges can need an item, or give one to whoever succeeds.</p>}
      <div className="editor-list">
        {seed.items.map((item, index) => {
          const holders = seed.characters.filter((character) => character.inventory[item.id]).map((character) => character.name);
          const needed = seed.challenges.filter((challenge) => challenge.requiresItemId === item.id).map((challenge) => challenge.name);
          const given = seed.challenges.filter((challenge) => challenge.onSuccess?.grantItems?.some((grant) => grant.itemId === item.id)).map((challenge) => challenge.name);
          const uses = [holders.length ? `carried by ${holders.join(", ")}` : "nobody carries it", needed.length ? `needed for ${needed.join(", ")}` : null, given.length ? `given by ${given.join(", ")}` : null];
          return (
            <CardEditor key={item.id} id={item.id} number={index + 1} kind="item" title={item.name} subtitle={uses.filter(Boolean).join(" · ")}
              open={cards.open === item.id} onToggle={() => cards.toggle(item.id)}>
              <LiveText label="Name" value={item.name} maxLength={100} commit={(name) => apply((current) => upsertItem(current, { id: item.id, name }))} />
              <LiveText label="What it looks like" multiline rows={2} maxLength={1000} value={item.description ?? ""}
                commit={(description) => apply((current) => upsertItem(current, { id: item.id, description }))} />
              <div className="card-actions">
                <span className="muted small">ID {item.id} · hand it out in Characters</span>
                <RemoveButton label="item" onRemove={() => removeEntity("item", item.id)} />
              </div>
            </CardEditor>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

export function ChallengesSection(props: SectionProps) {
  const { editor, draft, focus } = props;
  const { seed } = draft;
  const cards = useOpenCard(focus);
  const removeEntity = useRemove(props);
  const firstPlace = seed.locations[0]?.id;
  const stats = statOptions(seed);
  return (
    <>
      <AddRow label="New challenge" placeholder="Add a challenge, e.g. Win Mrs. Hale's trust" disabled={!firstPlace} hint="Add a place first: every challenge is somewhere."
        onAdd={(name) => {
          const outcome = editor.apply((current) => upsertChallenge(current, {
            name, placeId: firstPlace!, ...(stats ? { ability: "strength" } : {}), difficulty: "moderate", minutes: 5,
          }));
          if (typeof outcome === "string") return outcome;
          const id = added(draft, outcome.draft, "challenges");
          if (id) cards.show(id);
          return null;
        }} />
      {seed.challenges.length === 0 && seed.locations.length > 0 && <p className="muted">No challenges yet. An obstacle with more than one way through makes a good start.</p>}
      <div className="editor-list">
        {seed.challenges.map((challenge, index) => (
          <ChallengeCard key={challenge.id} {...props} challenge={challenge} number={index + 1}
            open={cards.open === challenge.id} onToggle={() => cards.toggle(challenge.id)} onRemove={() => removeEntity("challenge", challenge.id)} />
        ))}
      </div>
    </>
  );
}

function ChallengeCard({ editor, draft, challenge, number, open, onToggle, onRemove }: SectionProps & {
  challenge: Challenge;
  number: number;
  open: boolean;
  onToggle(): void;
  onRemove(): void;
}) {
  const { seed } = draft;
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  const id = challenge.id;
  const placeKnown = seed.locations.some((location) => location.id === challenge.locationId);
  const routes = allRoutes(seed);
  const threats = seed.threats ?? [];
  const success = challenge.onSuccess ?? {};
  const failure = challenge.onFailure ?? {};
  const refs = (list: readonly { fromId: string; destinationId: string }[] | undefined) => (list ?? []).map((ref) => `${ref.fromId}>${ref.destinationId}`);
  const toRoutes = (keys: string[]) => keys.map((key) => {
    const [fromId, toId] = key.split(">") as [string, string];
    return { fromId, toId };
  });
  const opens = refs(success.unlockRoutes);
  const blocks = refs(failure.lockRoutes);
  const waiting = threats.filter((threat) => threat.status === "waiting");
  const rules = rulesOf(seed);
  const stats = statOptions(seed);
  const statName = stats?.find((stat) => stat.value === challenge.ability)?.label;
  const subtitle = [
    placeKnown ? nameIn(seed, challenge.locationId) : "nowhere", statName, bandOf(challenge.difficulty), `${minutes(challenge.seconds)} min`,
  ].filter(Boolean).join(" · ");
  return (
    <CardEditor id={id} number={number} title={challenge.name} subtitle={subtitle} open={open} onToggle={onToggle} flagged={!placeKnown}>
      <div className="form-grid">
        <LiveText label="Name" value={challenge.name} maxLength={100} commit={(name) => apply((current) => upsertChallenge(current, { id, name }))} />
        <Field label="Where">
          <select value={challenge.locationId} onChange={(event) => apply((current) => upsertChallenge(current, { id, placeId: event.target.value }))}>
            {!placeKnown && <option value={challenge.locationId}>(choose a place)</option>}
            {seed.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
        </Field>
      </div>
      <LiveText label="What it looks like to those present" multiline rows={2} maxLength={1000} value={challenge.description ?? ""}
        commit={(description) => apply((current) => upsertChallenge(current, { id, description }))} />
      {rules.outcomes === "judgment" && (
        <LiveText label="What it takes" multiline rows={3} maxLength={1000} value={challenge.criteria ?? ""}
          placeholder="e.g. Succeeds only if they ask kindly, mention what they noticed, and do not pry."
          hint={<><strong>Hidden: only the referee reads it.</strong> Say in checkable terms what the character must have found out, carry, or say, and what makes it fail.</>}
          commit={(criteria) => apply((current) => upsertChallenge(current, { id, criteria }))} />
      )}
      <Field label={rules.outcomes === "judgment" ? "How hard it is" : "The check"}>
        <div className="row wrap">
          {stats && <Segmented label="Stat" value={challenge.ability} options={stats} onChange={(ability) => apply((current) => upsertChallenge(current, { id, ability }))} />}
          <Segmented label="Difficulty" value={bandOf(challenge.difficulty)} options={BANDS} onChange={(difficulty) => apply((current) => upsertChallenge(current, { id, difficulty }))} />
        </div>
      </Field>
      <div className="form-grid three">
        <Field label="An attempt takes">
          <Stepper label="minutes per attempt" value={minutes(challenge.seconds)} min={1} max={60} unit="min" onChange={(next) => apply((current) => upsertChallenge(current, { id, minutes: next }))} />
        </Field>
        {rules.health !== null && (
          <Field label={rules.health === "HP" ? "Damage on a failure" : `${rules.health} lost on a failure`}>
            <Stepper label="damage on failure" value={challenge.failureDamage} min={0} max={100} onChange={(failureDamage) => apply((current) => upsertChallenge(current, { id, failureDamage }))} />
          </Field>
        )}
        <Field label="Needs">
          <select value={challenge.requiresItemId ?? ""} onChange={(event) => apply((current) => upsertChallenge(current, { id, requiresItemId: event.target.value }))}>
            <option value="">nothing</option>
            {seed.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="group">
        <span className="eyebrow">If they succeed</span>
        <Field label="It opens">
          <ChipChoice options={routes.filter((route) => route.locked || opens.includes(route.key)).map((route) => ({ value: route.key, label: route.label }))}
            chosen={opens} empty="No blocked ways. Mark a way blocked in Places for this to open it."
            onChange={(next) => apply((current) => upsertChallenge(current, { id, opensRoutes: toRoutes(next) }))} />
        </Field>
        <Field label="It gives">
          <ChipChoice options={seed.items.map((item) => ({ value: item.id, label: item.name }))} chosen={(success.grantItems ?? []).map((grant) => grant.itemId)}
            empty="No items to give." onChange={(next) => apply((current) => upsertChallenge(current, { id, grantsItemIds: next }))} />
        </Field>
        <LiveText label="It reveals, only to whoever succeeds" multiline rows={2} maxLength={1000} value={success.reveals ?? ""}
          hint="A private discovery: the others learn it only if told." commit={(reveals) => apply((current) => upsertChallenge(current, { id, reveals }))} />
        <Field label="It sets off">
          <ChipChoice options={waiting.map((threat) => ({ value: threat.id, label: threat.name }))} chosen={success.armThreats ?? []}
            empty="No waiting threats. Add one in Threats, set to happen after a challenge sets it off."
            onChange={(next) => apply((current) => upsertChallenge(current, { id, armsThreatIds: next }))} />
        </Field>
        <Field label="It stops">
          <ChipChoice options={threats.map((threat) => ({ value: threat.id, label: threat.name }))} chosen={success.disarmThreats ?? []}
            empty="No threats." onChange={(next) => apply((current) => upsertChallenge(current, { id, disarmsThreatIds: next }))} />
        </Field>
      </div>
      <div className="group">
        <span className="eyebrow">If they fail</span>
        <Field label="It blocks">
          <ChipChoice options={routes.filter((route) => !route.locked || blocks.includes(route.key)).map((route) => ({ value: route.key, label: route.label }))}
            chosen={blocks} empty="No open ways." onChange={(next) => apply((current) => upsertChallenge(current, { id, failureBlocksRoutes: toRoutes(next) }))} />
        </Field>
        <Field label="It sets off">
          <ChipChoice options={waiting.map((threat) => ({ value: threat.id, label: threat.name }))} chosen={failure.armThreats ?? []}
            empty="No waiting threats." onChange={(next) => apply((current) => upsertChallenge(current, { id, failureArmsThreatIds: next }))} />
        </Field>
      </div>
      <div className="card-actions">
        <span className="muted small">ID {id}</span>
        <RemoveButton label="challenge" onRemove={onRemove} />
      </div>
    </CardEditor>
  );
}

// ---------------------------------------------------------------------------

export function ThreatsSection(props: SectionProps) {
  const { editor, draft, focus } = props;
  const { seed } = draft;
  const cards = useOpenCard(focus);
  const removeEntity = useRemove(props);
  const threats = seed.threats ?? [];
  return (
    <>
      <AddRow label="New threat" placeholder="Add a threat, e.g. The last ferry leaves" onAdd={(name) => {
        const outcome = editor.apply((current) => upsertThreat(current, { name, text: `${name}.`, startsAtMinute: 30 }));
        if (typeof outcome === "string") return outcome;
        const id = added(draft, outcome.draft, "threats");
        if (id) cards.show(id);
        return null;
      }} />
      {threats.length === 0 && <p className="muted">No threats. Something the world does on its own clock makes waiting cost something.</p>}
      <div className="editor-list">
        {threats.map((threat, index) => (
          <ThreatCard key={threat.id} {...props} threat={threat} number={index + 1}
            open={cards.open === threat.id} onToggle={() => cards.toggle(threat.id)} onRemove={() => removeEntity("threat", threat.id)} />
        ))}
      </div>
    </>
  );
}

function ThreatCard({ editor, draft, threat, number, open, onToggle, onRemove }: SectionProps & {
  threat: Threat;
  number: number;
  open: boolean;
  onToggle(): void;
  onRemove(): void;
}) {
  const { seed } = draft;
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  const id = threat.id;
  const routes = allRoutes(seed);
  const refs = (list: readonly { fromId: string; destinationId: string }[] | undefined) => (list ?? []).map((ref) => `${ref.fromId}>${ref.destinationId}`);
  const toRoutes = (keys: string[]) => keys.map((key) => {
    const [fromId, toId] = key.split(">") as [string, string];
    return { fromId, toId };
  });
  const armed = threat.status === "armed";
  const when = armed ? minutes(threat.at ?? 60) : minutes(threat.delaySeconds ?? 60);
  const setters = seed.challenges.filter((challenge) => challenge.onSuccess?.armThreats?.includes(id) || challenge.onFailure?.armThreats?.includes(id));
  const where = threat.locationIds?.map((placeId) => nameIn(seed, placeId)).join(", ") ?? "everywhere";
  const { health } = rulesOf(seed);
  const subtitle = `${armed ? `at minute ${when}` : `${when} min after it is set off`} · ${where}${threat.damage ? ` · ${threat.damage} damage` : ""}`;
  const ends = (seed.endings ?? []).find(({ when: trigger }) => "threatId" in trigger && trigger.threatId === id);
  const people = seed.characters.map((character) => ({ value: character.id, label: character.name }));
  const entering = (threat.enters ?? []).map((entry) => entry.characterId);
  // Everyone a threat brings in arrives at one place, by default where it strikes.
  const arrival = threat.enters?.[0]?.locationId ?? threat.locationIds?.[0] ?? seed.locations[0]?.id;
  const bringIn = (characterIds: string[], placeId = arrival) => apply((current) => upsertThreat(current, {
    id, bringsIn: placeId === undefined ? [] : characterIds.map((characterId) => ({ characterId, placeId })),
  }));
  return (
    <CardEditor id={id} number={number} kind="threat" title={threat.name} subtitle={subtitle} open={open} onToggle={onToggle}>
      <LiveText label="Name, for you" value={threat.name} maxLength={100} commit={(name) => apply((current) => upsertThreat(current, { id, name }))} />
      <LiveText label="What those it strikes notice" multiline rows={2} maxLength={500} value={threat.text}
        commit={(text) => apply((current) => upsertThreat(current, { id, text }))} />
      <Field label="When it happens">
        <div className="row wrap">
          <Segmented label="When" value={armed ? "armed" : "waiting"}
            options={[{ value: "armed", label: "At a set time" }, { value: "waiting", label: "After a challenge sets it off" }]}
            onChange={(next) => apply((current) => upsertThreat(current, next === "armed" ? { id, startsAtMinute: when } : { id, afterMinutes: when }))} />
          <Stepper label={armed ? "minute it happens" : "minutes after it is set off"} value={when} min={1} max={1440} unit="min"
            onChange={(next) => apply((current) => upsertThreat(current, armed ? { id, startsAtMinute: next } : { id, afterMinutes: next }))} />
        </div>
      </Field>
      {!armed && (
        <span className={setters.length ? "field-hint" : "field-error"}>
          {setters.length ? `Set off by ${setters.map((challenge) => `"${challenge.name}"`).join(", ")}.` : "Nothing sets it off yet: choose it under a challenge's outcome."}
        </span>
      )}
      <Field label="Where it strikes" hint="Choose none for everywhere.">
        <ChipChoice options={seed.locations.map((location) => ({ value: location.id, label: location.name }))} chosen={threat.locationIds ?? []}
          empty="No places yet." onChange={(placeIds) => apply((current) => upsertThreat(current, { id, placeIds }))} />
      </Field>
      {health !== null && (
        <Field label={health === "HP" ? "Damage to each person there" : `${health} each person there loses`}>
          <Stepper label="damage" value={threat.damage ?? 0} min={0} max={100} onChange={(damage) => apply((current) => upsertThreat(current, { id, damage }))} />
        </Field>
      )}
      {ends && <span className="field-hint">When it happens, the story ends: "{ends.name}".</span>}
      <Field label="It blocks">
        <ChipChoice options={routes.filter((route) => !route.locked || refs(threat.lockRoutes).includes(route.key)).map((route) => ({ value: route.key, label: route.label }))}
          chosen={refs(threat.lockRoutes)} empty="No ways yet." onChange={(next) => apply((current) => upsertThreat(current, { id, blocksRoutes: toRoutes(next) }))} />
      </Field>
      <Field label="It opens">
        <ChipChoice options={routes.filter((route) => route.locked || refs(threat.unlockRoutes).includes(route.key)).map((route) => ({ value: route.key, label: route.label }))}
          chosen={refs(threat.unlockRoutes)} empty="No blocked ways." onChange={(next) => apply((current) => upsertThreat(current, { id, opensRoutes: toRoutes(next) }))} />
      </Field>
      <Field label="It brings in" hint="Usually someone who starts away, such as a boss who joins the call.">
        <ChipChoice options={people.filter((person) => !threat.exits?.includes(person.value))} chosen={entering} empty="No characters yet."
          onChange={(next) => bringIn(next)} />
      </Field>
      {entering.length > 0 && arrival !== undefined && (
        <Field label="They arrive at">
          <select value={arrival} onChange={(event) => bringIn(entering, event.target.value)}>
            {seed.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="It sends away">
        <ChipChoice options={people.filter((person) => !entering.includes(person.value))} chosen={threat.exits ?? []} empty="No characters yet."
          onChange={(sendsAway) => apply((current) => upsertThreat(current, { id, sendsAway }))} />
      </Field>
      <div className="card-actions">
        <span className="muted small">ID {id}</span>
        <RemoveButton label="threat" onRemove={onRemove} />
      </div>
    </CardEditor>
  );
}

// ---------------------------------------------------------------------------

/** "When X succeeds", "When Y happens": what an ending waits on, in words. */
function triggerPhrase(seed: Seed, when: Ending["when"]): string {
  if ("threatId" in when) return `when "${nameIn(seed, when.threatId)}" happens`;
  return `when "${nameIn(seed, when.challengeId)}" ${when.outcome === "success" ? "succeeds" : "fails"}`;
}

const triggerKey = (when: Ending["when"]) => ("threatId" in when ? `threat:${when.threatId}` : `${when.outcome}:${when.challengeId}`);

export function EndingsSection(props: SectionProps) {
  const { editor, draft, focus } = props;
  const { seed } = draft;
  const cards = useOpenCard(focus);
  const removeEntity = useRemove(props);
  const endings = seed.endings ?? [];
  const firstChallenge = seed.challenges[0]?.id;
  const firstThreat = seed.threats?.[0]?.id;
  return (
    <>
      <AddRow label="New ending" placeholder="Add an ending, e.g. Together, or Full outage" disabled={!firstChallenge && !firstThreat}
        hint="Add a challenge or a threat first: an ending waits on one."
        onAdd={(name) => {
          const trigger = firstChallenge ? { challengeId: firstChallenge } : { threatId: firstThreat! };
          const outcome = editor.apply((current) => upsertEnding(current, { name, text: `${name}.`, ...trigger }));
          if (typeof outcome === "string") return outcome;
          const id = added(draft, outcome.draft, "endings");
          if (id) cards.show(id);
          return null;
        }} />
      {endings.length === 0 && (
        <p className="muted">No endings. They are optional: without one, the story runs until you stop it. With one, a challenge's success or failure, or a threat, closes it.</p>
      )}
      <div className="editor-list">
        {endings.map((ending, index) => (
          <EndingCard key={ending.id} {...props} ending={ending} number={index + 1}
            open={cards.open === ending.id} onToggle={() => cards.toggle(ending.id)} onRemove={() => removeEntity("ending", ending.id)} />
        ))}
      </div>
    </>
  );
}

function EndingCard({ editor, draft, ending, number, open, onToggle, onRemove }: SectionProps & {
  ending: Ending;
  number: number;
  open: boolean;
  onToggle(): void;
  onRemove(): void;
}) {
  const { seed } = draft;
  const apply = (edit: Edit) => refusal(editor.apply(edit));
  const id = ending.id;
  const triggers = [
    ...seed.challenges.flatMap((challenge) => [
      { value: `success:${challenge.id}`, label: `"${challenge.name}" succeeds` },
      { value: `failure:${challenge.id}`, label: `"${challenge.name}" fails` },
    ]),
    ...(seed.threats ?? []).map((threat) => ({ value: `threat:${threat.id}`, label: `"${threat.name}" happens` })),
  ];
  const current = triggerKey(ending.when);
  const known = triggers.some((trigger) => trigger.value === current);
  return (
    <CardEditor id={id} number={number} kind="ending" title={ending.name} subtitle={`Ends the story ${triggerPhrase(seed, ending.when)}`}
      open={open} onToggle={onToggle} flagged={!known}>
      <LiveText label="Name, for you" value={ending.name} maxLength={100} commit={(name) => apply((draftNow) => upsertEnding(draftNow, { id, name }))} />
      <LiveText label="What everyone reads at the end" multiline rows={3} maxLength={1000} value={ending.text}
        hint="One to three sentences that close the story. The narrator may add a line after it."
        commit={(text) => apply((draftNow) => upsertEnding(draftNow, { id, text }))} />
      <Field label="The story ends this way when">
        <select value={current} onChange={(event) => {
          const [kind, target] = event.target.value.split(/:(.*)/s) as [string, string];
          apply((draftNow) => upsertEnding(draftNow, kind === "threat"
            ? { id, threatId: target }
            : { id, challengeId: target, outcome: kind === "failure" ? "failure" : "success" }));
        }}>
          {!known && <option value={current}>(choose what ends it)</option>}
          {triggers.map((trigger) => <option key={trigger.value} value={trigger.value}>{trigger.label}</option>)}
        </select>
      </Field>
      <div className="card-actions">
        <span className="muted small">ID {id}</span>
        <RemoveButton label="ending" onRemove={onRemove} />
      </div>
    </CardEditor>
  );
}

// ---------------------------------------------------------------------------

export function ProblemList({ problems, onGo }: { problems: SectionProps["editor"]["problems"]; onGo(section: DraftSection, id?: string): void }) {
  if (problems.length === 0) return null;
  return (
    <ul className="problem-list">
      {problems.map((problem, index) => (
        <li key={index} className={problem.severity}>
          {problem.severity === "error" ? <CircleAlert size={16} /> : <AlertTriangle size={16} />}
          <span className="grow">{problem.message}</span>
          <button type="button" className="link small" onClick={() => onGo(problem.section, problem.id)}>Fix</button>
        </li>
      ))}
    </ul>
  );
}
