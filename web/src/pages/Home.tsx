import { useEffect, useState } from "react";
import { Clock, FilePen, Globe, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, errorText } from "../api.ts";
import { ago, clock } from "../format.ts";
import { draftPath, linkProps, navigate, worldPath } from "../router.ts";
import type { DraftSummary, WorldSummary } from "../types.ts";
import { EmptyState } from "../ui/controls.tsx";

export function Home() {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.worlds(), api.drafts()])
      .then(([listed, written]) => {
        setWorlds(listed.worlds);
        setKeyConfigured(listed.keyConfigured);
        setDrafts(written.drafts);
      })
      .catch((problem) => setError(errorText(problem)));
  }, []);

  async function discard(draft: DraftSummary) {
    if (!window.confirm(`Delete the draft "${draft.name}"?${draft.worldId ? " The world it became stays." : ""}`)) return;
    try {
      await api.deleteDraft(draft.id);
      setDrafts((current) => current.filter((entry) => entry.id !== draft.id));
    } catch (problem) {
      setError(errorText(problem));
    }
  }

  const writing = drafts.filter((draft) => draft.publishedAt === null);
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Director</span>
          <h1>Your worlds</h1>
          <p>Write a world, cast AI characters, watch them play, and steer the story. The engine decides every outcome.</p>
        </div>
        <button type="button" className="primary" onClick={() => navigate("/new")}><Plus size={16} />New world</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!keyConfigured && (
        <p className="notice">
          <KeyRound size={16} />
          <span>
            No OpenRouter key is set, so models cannot play or help write yet. Add <code>OPENROUTER_API_KEY</code> to{" "}
            <code>.env.local</code> and restart the server. The scripted opening of The Dry Aqueduct plays without one.
          </span>
        </p>
      )}

      {writing.length > 0 && (
        <>
          <div className="section-title"><h2>Drafts</h2><span className="muted small">Worlds you are still writing</span></div>
          <div className="card-grid">
            {writing.map((draft) => (
              <div key={draft.id} className="card dashed">
                <a className="row" style={{ color: "inherit", textDecoration: "none" }} {...linkProps(draftPath(draft.id))}>
                  <span className="number"><FilePen size={14} /></span>
                  <strong className="grow">{draft.name}</strong>
                </a>
                <div className="row small muted">
                  <span className="grow">Edited {ago(draft.updatedAt)}</span>
                  <button type="button" className="icon-button" aria-label={`Delete ${draft.name}`} title="Delete draft" onClick={() => void discard(draft)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title"><h2>Worlds</h2></div>
      {worlds === null ? <p className="muted">Loading…</p> : worlds.length === 0 ? (
        <div className="card dashed">
          <EmptyState icon={<Globe size={22} />} title="No worlds yet">
            <p>Write one with the creator, or copy a bundled story.</p>
            <button type="button" className="primary" onClick={() => navigate("/new")}><Plus size={16} />New world</button>
          </EmptyState>
        </div>
      ) : (
        <div className="card-grid">
          {worlds.map((world) => (
            <a key={world.id} className="card world-card" {...linkProps(worldPath(world.id))}>
              <strong>{world.name}</strong>
              <span className="muted small">{world.id}</span>
              <span className="meta-line">
                <span><Clock size={13} />{clock(world.elapsedSeconds)}</span>
                <span>revision {world.revision}</span>
                <span>{ago(world.updatedAt)}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
