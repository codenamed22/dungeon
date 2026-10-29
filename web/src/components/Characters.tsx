import { useState } from "react";
import type { FormEvent } from "react";
import { rulesOf } from "../../../src/model.ts";
import { api, errorText } from "../api.ts";
import { nameOf } from "../format.ts";
import type { RunStatus, WorldView } from "../types.ts";

/** Bringing someone into the scene, or sending them away, as the director. */
interface Staging {
  characterId: string;
  entering: boolean;
  locationId: string;
  text: string;
}

/** Character sheets, with the director's per-character controls: mute, cue, inspect, bring in, send away. */
export function Characters({ worldId, view, run, onInspect, onChange }: {
  worldId: string;
  view: WorldView;
  run: RunStatus | null;
  onInspect(characterId: string): void;
  onChange(view: WorldView): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [staging, setStaging] = useState<Staging | null>(null);
  const state = view.world;
  const running = run?.state === "running" || run?.state === "pausing";
  const { health } = rulesOf(state);
  const ended = state.endedWith !== undefined;

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (problem) {
      setError(errorText(problem));
    }
  }

  async function stage(event: FormEvent) {
    event.preventDefault();
    if (!staging) return;
    const text = staging.text.trim() || undefined;
    await act(async () => {
      if (staging.entering) await api.enter(worldId, staging.characterId, staging.locationId, text);
      else await api.exit(worldId, staging.characterId, text);
      setStaging(null);
    });
  }

  return (
    <div className="stack">
      {error && <p className="error small">{error}</p>}
      {state.characters.map((character) => {
        const persona = character.npc ? view.setup.cast.npcs?.[character.id] : view.setup.cast.characters[character.id];
        const muted = view.muted.includes(character.id);
        const away = character.away === true;
        const items = Object.entries(character.inventory).map(([id, count]) => `${nameOf(state, id)}${count > 1 ? ` ×${count}` : ""}`);
        const open = (character.goals ?? []).filter((goal) => goal.status === "adopted");
        const form = staging?.characterId === character.id ? staging : null;
        return (
          <div key={character.id} className={`sheet ${character.hp === 0 ? "down" : ""} ${away ? "away" : ""}`}>
            <div className="row">
              <strong>{character.name}</strong>
              {character.npc && <span className="tag">supporting</span>}
              {!persona && <span className="tag" title="No persona: no agent plays this character">no agent</span>}
              {muted && <span className="tag">muted</span>}
              {away && <span className="tag" title="Away from the scene: takes no turns, and nobody can see or hear them">away</span>}
              <span className="muted small grow right">{away ? `last at ${nameOf(state, character.locationId)}` : nameOf(state, character.locationId)}</span>
            </div>
            {health !== null && (
              <div className="hp" title={`${character.hp} of ${character.maxHp} ${health}`}>
                <div style={{ width: `${(100 * character.hp) / character.maxHp}%` }} />
              </div>
            )}
            <div className="small muted">
              {health !== null && `${health} ${character.hp}/${character.maxHp} · `}{items.length > 0 ? items.join(", ") : "carrying nothing"}
              {open.length > 0 && ` · ${open.length} open goal(s)`}
            </div>
            <div className="row small wrap">
              <button className="link" onClick={() => onInspect(character.id)}>Inspect</button>
              <button className="link" disabled={!persona || running || !view.keyConfigured || character.hp === 0 || away || ended}
                title={away ? "Away from the scene: bring them in first" : view.keyConfigured ? "Give this character the next turn, even if muted" : "Needs OPENROUTER_API_KEY"}
                onClick={() => void act(() => api.step(worldId, character.id))}>Cue</button>
              <button className="link" onClick={() => void act(async () => onChange(await api.mute(worldId, [character.id], !muted)))}>
                {muted ? "Unmute" : "Mute"}
              </button>
              <button className="link" disabled={running || ended}
                title={away ? "Bring them into the scene, where you choose" : "Send them out of the scene: they take no turns until something brings them back"}
                onClick={() => setStaging(form ? null : { characterId: character.id, entering: away, locationId: character.locationId, text: "" })}>
                {away ? "Bring in" : "Send away"}
              </button>
            </div>
            {form && (
              <form className="stack stage-form" onSubmit={(event) => void stage(event)}>
                {form.entering && (
                  <label className="inline small">
                    At{" "}
                    <select value={form.locationId} onChange={(event) => setStaging({ ...form, locationId: event.target.value })}>
                      {state.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                    </select>
                  </label>
                )}
                <input
                  value={form.text}
                  maxLength={2000}
                  onChange={(event) => setStaging({ ...form, text: event.target.value })}
                  placeholder={form.entering ? `How it looks (optional), e.g. ${character.name} joins the call, yawning.` : `How it looks (optional), e.g. ${character.name} steps out to take a call.`}
                />
                <div className="row small">
                  <button type="submit" className="primary" disabled={running || ended}>{form.entering ? "Bring in" : "Send away"}</button>
                  <button type="button" className="link" onClick={() => setStaging(null)}>Cancel</button>
                  <span className="muted grow right">Whoever is there sees it happen.</span>
                </div>
              </form>
            )}
          </div>
        );
      })}
      <p className="muted small">
        A muted character neither takes turns nor answers when spoken to, until you unmute or cue it. Mutes are director state;
        no agent sees them. Someone away from the scene takes no turns, and nobody can see or hear them, until you or the story
        bring them in.
      </p>
    </div>
  );
}
