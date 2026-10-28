import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, errorText } from "../api.ts";
import type { AgentPrompts, MemoryReport, WorldView } from "../types.ts";

type Belief = MemoryReport["beliefs"][number]["current"];

function beliefSource(belief: Belief): string {
  const cited = belief.evidence.length === 0 ? "" : ` from ${belief.evidence.map((sequence) => `#${sequence}`).join(", ")}`;
  return belief.source === "observed" ? `seen${cited}` : `${belief.source}${cited}, ${belief.confidence} confidence`;
}

/** Snippets mark matches «like this». */
function Snippet({ text }: { text: string }) {
  return <>{text.split(/(«[^»]*»)/).map((part, index) => (
    part.startsWith("«") ? <mark key={index}>{part.slice(1, -1)}</mark> : <span key={index}>{part}</span>
  ))}</>;
}

/** Exactly what one character's agent is sent, and what the character remembers. */
export function Inspector({ worldId, view, characterId, onClose }: {
  worldId: string;
  view: WorldView;
  characterId: string;
  onClose(): void;
}) {
  const [tab, setTab] = useState<"prompt" | "memory">("prompt");
  const [prompts, setPrompts] = useState<AgentPrompts | null>(null);
  const [memory, setMemory] = useState<MemoryReport | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const character = view.world.characters.find((entry) => entry.id === characterId);
  const revision = view.world.revision;

  useEffect(() => {
    let current = true;
    setError(null);
    const load = tab === "prompt"
      ? api.agent(worldId, characterId).then((next) => { if (current) setPrompts(next); })
      : api.memory(worldId, characterId, search || undefined).then((next) => { if (current) setMemory(next); });
    load.catch((problem) => { if (current) setError(errorText(problem)); });
    return () => { current = false; };
  }, [worldId, characterId, tab, search, revision]);

  function find(event: FormEvent) {
    event.preventDefault();
    setSearch(query.trim());
  }

  return (
    <div className="stack">
      <div className="row">
        <button className="link" onClick={onClose}>← All characters</button>
        <strong className="grow">{character?.name ?? characterId}</strong>
      </div>
      <nav className="row">
        <button className={tab === "prompt" ? "tab active" : "tab"} onClick={() => setTab("prompt")}>What its agent is sent</button>
        <button className={tab === "memory" ? "tab active" : "tab"} onClick={() => setTab("memory")}>Memory</button>
      </nav>
      {error && <p className="error small">{error}</p>}
      {tab === "prompt" && prompts && (
        <>
          <h3>System prompt</h3>
          <pre className="prompt">{prompts.system ?? (prompts.npc ? "(No persona: this supporting character never speaks.)" : "(No persona: this character never takes turns.)")}</pre>
          <h3>{prompts.npc ? "Turn prompt, when someone speaks to them" : "Turn prompt, if it acted now"}</h3>
          <pre className="prompt">{prompts.prompt}</pre>
        </>
      )}
      {tab === "memory" && memory && (
        <>
          <h3>Goals and commitments</h3>
          {memory.goals.length === 0 ? <p className="muted small">None.</p> : (
            <ul className="small">
              {memory.goals.map((goal) => <li key={goal.id}>{goal.text} <span className="muted">({goal.kind}, {goal.status})</span></li>)}
            </ul>
          )}
          <h3>Beliefs</h3>
          {memory.beliefs.length === 0 ? <p className="muted small">None.</p> : (
            <ul className="small beliefs">
              {memory.beliefs.map((topic) => (
                <li key={`${topic.about}/${topic.attribute}`}>
                  <strong>{topic.aboutName ?? topic.about}</strong>, {topic.attribute}: {topic.current.value}{" "}
                  <span className="muted">[{beliefSource(topic.current)}]</span>
                  {topic.earlier.map((older) => (
                    <div key={older.sequence} className="muted superseded">was: {older.value} [{beliefSource(older)}]</div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          <h3>Private discoveries</h3>
          {memory.discoveries.length === 0 ? <p className="muted small">None.</p> : (
            <ul className="small">{memory.discoveries.map((entry) => <li key={entry.sequence}>#{entry.sequence} {entry.line}</li>)}</ul>
          )}
          <h3>Search what they perceived</h3>
          <form className="row" onSubmit={find}>
            <input className="grow" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. a name, a place, a clue" />
            <button type="submit">Search</button>
          </form>
          {memory.matches && (memory.matches.length === 0 ? <p className="muted small">Nothing they perceived matches.</p> : (
            <ul className="small">
              {memory.matches.map((match) => (
                <li key={match.sequence}>#{match.sequence} {match.line}{match.snippet && <div className="muted">…<Snippet text={match.snippet} />…</div>}</li>
              ))}
            </ul>
          ))}
        </>
      )}
    </div>
  );
}
