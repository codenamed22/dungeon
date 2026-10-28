import { useState } from "react";
import { rulesOf } from "../../../src/model.ts";
import { api, errorText } from "../api.ts";
import { nameOf } from "../format.ts";
import type { RunStatus, WorldView } from "../types.ts";

/** Character sheets, with the director's per-character controls: mute, cue, inspect. */
export function Characters({ worldId, view, run, onInspect, onChange }: {
  worldId: string;
  view: WorldView;
  run: RunStatus | null;
  onInspect(characterId: string): void;
  onChange(view: WorldView): void;
}) {
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="stack">
      {error && <p className="error small">{error}</p>}
      {state.characters.map((character) => {
        const persona = character.npc ? view.setup.cast.npcs?.[character.id] : view.setup.cast.characters[character.id];
        const muted = view.muted.includes(character.id);
        const items = Object.entries(character.inventory).map(([id, count]) => `${nameOf(state, id)}${count > 1 ? ` ×${count}` : ""}`);
        const open = (character.goals ?? []).filter((goal) => goal.status === "adopted");
        return (
          <div key={character.id} className={`sheet ${character.hp === 0 ? "down" : ""}`}>
            <div className="row">
              <strong>{character.name}</strong>
              {character.npc && <span className="tag">supporting</span>}
              {!persona && <span className="tag" title="No persona: no agent plays this character">no agent</span>}
              {muted && <span className="tag">muted</span>}
              <span className="muted small grow right">{nameOf(state, character.locationId)}</span>
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
            <div className="row small">
              <button className="link" onClick={() => onInspect(character.id)}>Inspect</button>
              <button className="link" disabled={!persona || running || !view.keyConfigured || character.hp === 0 || ended}
                title={view.keyConfigured ? "Give this character the next turn, even if muted" : "Needs OPENROUTER_API_KEY"}
                onClick={() => void act(() => api.step(worldId, character.id))}>Cue</button>
              <button className="link" onClick={() => void act(async () => onChange(await api.mute(worldId, [character.id], !muted)))}>
                {muted ? "Unmute" : "Mute"}
              </button>
            </div>
          </div>
        );
      })}
      <p className="muted small">
        A muted character neither takes turns nor answers when spoken to, until you unmute or cue it. Mutes are director state;
        no agent sees them.
      </p>
    </div>
  );
}
