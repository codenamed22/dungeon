import { useState } from "react";
import type { FormEvent } from "react";
import { api, errorText } from "../api.ts";
import type { WorldView } from "../types.ts";

type Mode = "steer" | "introduce";

/**
 * The director's two voices. Steering is out of the story: the characters it
 * names see it once, in their next prompt, and nobody remembers it. An
 * introduced event happens in the story, where you say, and whoever is there
 * perceives and remembers it.
 */
export function DirectorBox({ worldId, view }: { worldId: string; view: WorldView }) {
  const [mode, setMode] = useState<Mode>("steer");
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [places, setPlaces] = useState<string[]>([]);
  const [routeChange, setRouteChange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const state = view.world;
  const main = state.characters.filter((character) => !character.npc);
  const routes = state.locations.flatMap((location) => location.routes.map((route) => ({
    key: `${location.id}>${route.destinationId}`,
    label: `${location.name} → ${state.locations.find((entry) => entry.id === route.destinationId)?.name ?? route.destinationId}`,
    locked: route.locked === true,
    ref: { fromId: location.id, destinationId: route.destinationId },
  })));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      if (mode === "steer") {
        await api.steer(worldId, text, target || undefined);
        setSent(`Steering recorded for ${target ? state.characters.find((entry) => entry.id === target)?.name : "everyone"}.`);
      } else {
        const route = routes.find((entry) => entry.key === routeChange);
        await api.introduce(worldId, {
          text,
          ...(places.length > 0 ? { locationIds: places } : {}),
          ...(route ? (route.locked ? { unlockRoutes: [route.ref] } : { lockRoutes: [route.ref] }) : {}),
        });
        setSent("The event happened.");
        setRouteChange("");
      }
      setText("");
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="director-box" onSubmit={(event) => void submit(event)}>
      <div className="row">
        <button type="button" className={mode === "steer" ? "tab active" : "tab"} onClick={() => setMode("steer")}>Steer</button>
        <button type="button" className={mode === "introduce" ? "tab active" : "tab"} onClick={() => setMode("introduce")}>Introduce an event</button>
        <span className="muted small grow right director-hint">
          {mode === "steer" ? "Out of the story: seen once, never remembered, changes nothing by itself." : "In the story: perceived and remembered by whoever is there."}
        </span>
      </div>
      <textarea
        rows={2}
        value={text}
        maxLength={mode === "steer" ? 500 : 1000}
        onChange={(event) => setText(event.target.value)}
        placeholder={mode === "steer"
          ? "e.g. You have talked long enough. Try something different, or ask the person who knows."
          : "e.g. The lights flicker, and a phone starts ringing in the next room."}
      />
      <div className="row wrap">
        {mode === "steer" ? (
          <label className="inline">
            To{" "}
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">everyone</option>
              {main.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
            </select>
          </label>
        ) : (
          <>
            <span className="small">Where:</span>
            {state.locations.map((location) => (
              <label key={location.id} className="inline small">
                <input
                  type="checkbox"
                  checked={places.includes(location.id)}
                  onChange={(event) => setPlaces(event.target.checked ? [...places, location.id] : places.filter((id) => id !== location.id))}
                />{" "}
                {location.name}
              </label>
            ))}
            <span className="muted small">{places.length === 0 ? "(everywhere)" : ""}</span>
            <label className="inline small">
              and{" "}
              <select value={routeChange} onChange={(event) => setRouteChange(event.target.value)}>
                <option value="">change no route</option>
                {routes.map((route) => (
                  <option key={route.key} value={route.key}>{route.locked ? "open" : "block"} {route.label}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <button type="submit" className="primary right" disabled={busy || !text.trim()}>
          {mode === "steer" ? "Send steering" : "Make it happen"}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {sent && <p className="muted small">{sent}</p>}
    </form>
  );
}
