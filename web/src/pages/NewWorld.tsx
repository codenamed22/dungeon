import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Copy, FilePlus2, Play, Sparkles } from "lucide-react";
import { api, errorText } from "../api.ts";
import { freshId } from "../format.ts";
import { draftPath, navigate, worldPath } from "../router.ts";
import type { AdventureInfo } from "../types.ts";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Three ways to start a world in the creator, and a quick way to play a bundled one as it is. */
export function NewWorld() {
  const [adventures, setAdventures] = useState<AdventureInfo[]>([]);
  const [taken, setTaken] = useState<string[]>([]);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.adventures(), api.worlds()])
      .then(([bundled, listed]) => {
        setAdventures(bundled);
        setTaken(listed.worlds.map((world) => world.id));
      })
      .catch((problem) => setError(errorText(problem)));
  }, []);

  async function start(body: { adventureId?: string }, assistant = false) {
    setBusy(true);
    setError(null);
    try {
      const draft = await api.createDraft(body);
      const path = draftPath(draft.id, { assistant });
      navigate(assistant && idea.trim() ? `${path}&prompt=${encodeURIComponent(idea.trim().slice(0, 1000))}` : path);
    } catch (problem) {
      setError(errorText(problem));
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">New world</span>
          <h1>Start a world</h1>
          <p>Every way opens the creator, where you can change anything before it becomes a world.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="choice-grid">
        <div className="card">
          <span className="card-icon"><Sparkles size={19} /></span>
          <strong>Describe it to the AI</strong>
          <p>Say what you want, and the AI creator builds it while you watch. Each message can be undone.</p>
          <textarea rows={2} value={idea} maxLength={1000} onChange={(event) => setIdea(event.target.value)}
            placeholder="e.g. Two rival chefs forced to share a kitchen, or a lighthouse keeper who lies" aria-label="Your idea" />
          <div><button type="button" className="primary" disabled={busy} onClick={() => void start({}, true)}><Sparkles size={15} />Open the creator</button></div>
        </div>
        <button type="button" className="card" disabled={busy} onClick={() => void start({})}>
          <span className="card-icon"><FilePlus2 size={19} /></span>
          <strong>Blank</strong>
          <p>Start from nothing, writing places, characters, and challenges with simple forms.</p>
        </button>
        {adventures.map((adventure) => (
          <button key={adventure.id} type="button" className="card" disabled={busy} onClick={() => void start({ adventureId: adventure.id })}>
            <span className="card-icon"><Copy size={18} /></span>
            <strong>Copy {adventure.name}</strong>
            <p>{adventure.summary}</p>
          </button>
        ))}
      </div>
      <QuickStart adventures={adventures} taken={taken} />
    </main>
  );
}

function QuickStart({ adventures, taken }: { adventures: AdventureInfo[]; taken: string[] }) {
  const [adventureId, setAdventureId] = useState("aqueduct");
  const [worldId, setWorldId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggested = freshId(adventureId, taken);
  const id = worldId.trim() || suggested;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!ID_PATTERN.test(id)) {
      setError("A world ID uses letters, digits, - and _, starting with a letter or digit.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWorld({ id, adventureId });
      navigate(worldPath(created.world.id));
    } catch (problem) {
      setError(errorText(problem));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-title"><h2>Or play one as it is</h2></div>
      <form className="publish-bar" onSubmit={(event) => void create(event)}>
        <label className="field">
          Story
          <select value={adventureId} onChange={(event) => setAdventureId(event.target.value)}>
            {adventures.map((adventure) => <option key={adventure.id} value={adventure.id}>{adventure.name}</option>)}
          </select>
        </label>
        <label className="field">
          World ID
          <input value={worldId} onChange={(event) => setWorldId(event.target.value)} placeholder={suggested} />
        </label>
        <button type="submit" disabled={busy}><Play size={15} />{busy ? "Creating…" : "Create and open"}</button>
        {error && <p className="error small" style={{ flexBasis: "100%", margin: 0 }}>{error}</p>}
      </form>
    </>
  );
}
