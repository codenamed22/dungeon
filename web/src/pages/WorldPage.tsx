import { useState } from "react";
import { BookOpen, Bot, Clock, Ellipsis, Map as MapIcon, Play, Users, WandSparkles } from "lucide-react";
import { Characters } from "../components/Characters.tsx";
import { Controls } from "../components/Controls.tsx";
import { DirectorBox } from "../components/DirectorBox.tsx";
import { EditorPanel } from "../components/EditorPanel.tsx";
import { Feed } from "../components/Feed.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { ReportPanel } from "../components/ReportPanel.tsx";
import { SetupEditor } from "../components/SetupEditor.tsx";
import { TracesPanel } from "../components/TracesPanel.tsx";
import { WorldPanel } from "../components/WorldPanel.tsx";
import { clock } from "../format.ts";
import { linkProps } from "../router.ts";
import { SheetDialog } from "../ui/Dialog.tsx";
import { Segmented } from "../ui/controls.tsx";
import { NARROW, useMedia, useOverlay } from "../ui/hooks.ts";
import { useWorld } from "../useWorld.ts";

type Tab = "characters" | "world" | "setup" | "report" | "traces";
/** On a phone one pane shows at a time: the story, or one of the side tabs. */
type Pane = "story" | Tab;

const TABS: { id: Tab; label: string }[] = [
  { id: "characters", label: "Characters" },
  { id: "world", label: "World" },
  { id: "setup", label: "Agents" },
  { id: "report", label: "Report" },
  { id: "traces", label: "Model calls" },
];

const BOTTOM: { id: Pane; label: string; icon: typeof BookOpen; also?: Pane }[] = [
  { id: "story", label: "Story", icon: BookOpen },
  { id: "characters", label: "Cast", icon: Users },
  { id: "world", label: "World", icon: MapIcon },
  { id: "setup", label: "Agents", icon: Bot },
  { id: "report", label: "More", icon: Ellipsis, also: "traces" },
];

export function WorldPage({ worldId }: { worldId: string }) {
  const live = useWorld(worldId);
  const { view, events, run } = live;
  const narrow = useMedia(NARROW);
  const [tab, setTab] = useState<Tab>("characters");
  const [pane, setPane] = useState<Pane>("story");
  const [inspected, setInspected] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [controls, setControls] = useState(false);
  const editor = useOverlay("editor");

  if (!view) {
    return (
      <main className="page">
        {live.error ? <p className="error">{live.error}</p> : <p className="muted">Loading {worldId}…</p>}
      </main>
    );
  }
  const { world } = view;
  const running = run?.state === "running" || run?.state === "pausing";
  const ending = world.endings?.find((entry) => entry.id === world.endedWith);
  const choose = (next: Pane) => {
    setPane(next);
    if (next !== "story") setTab(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="world-page" data-pane={pane}>
      <header className="world-header">
        <div>
          <span className="eyebrow"><a {...linkProps("/")}>Worlds</a> / {world.id}</span>
          <h1>{world.name}</h1>
          <div className="meta-line">
            <span><Clock size={13} />{clock(world.elapsedSeconds)}</span>
            <span>revision {world.revision}</span>
            {ending && <span className="status quiet">ended</span>}
            <span className={`status ${live.live ? "good" : "busy pulse"}`}>{live.live ? "live" : "reconnecting"}</span>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className={`editor-button ${editor.open ? "active" : ""}`} aria-expanded={editor.open} aria-label="Story editor"
            title="Have the story editor review the story and fix what isn't working" onClick={editor.open ? editor.hide : editor.show}>
            <WandSparkles size={15} /><span className="label">Editor</span>
          </button>
          {narrow ? (
            <button type="button" className={`run-pill ${running ? "running" : ""}`} onClick={() => setControls(true)}>
              <Play size={15} fill="currentColor" />{running ? `${run.turns} turn${run.turns === 1 ? "" : "s"}…` : ending ? "Ended" : "Run"}
            </button>
          ) : <Controls worldId={worldId} view={view} run={run} />}
        </div>
      </header>
      {live.error && <p className="error" style={{ padding: "8px 16px" }}>{live.error}</p>}
      <div className="world-body">
        <section className="feed-column">
          <div className="feed-toolbar">
            <label className="inline">
              Show
              <select value={viewer ?? ""} onChange={(event) => setViewer(event.target.value || null)}>
                <option value="">everything (director view)</option>
                {world.characters.map((character) => (
                  <option key={character.id} value={character.id}>what {character.name} perceived</option>
                ))}
              </select>
            </label>
          </div>
          <Feed worldId={worldId} view={view} events={events} viewer={viewer} />
          {ending ? (
            <div className="ended-banner" role="status">
              <span className="eyebrow">The story ended · {ending.name}</span>
              <p>{ending.text}</p>
              <p className="muted small">Nothing more happens in this world. To play on, open the "…" menu on an earlier event and branch from there.</p>
            </div>
          ) : <DirectorBox worldId={worldId} view={view} />}
        </section>
        <aside className="side-column">
          <nav className="tabs" aria-label="World panels">
            {TABS.map((entry) => (
              <button key={entry.id} type="button" className={tab === entry.id ? "tab active" : "tab"} onClick={() => setTab(entry.id)}>
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="side-content">
            {narrow && (tab === "report" || tab === "traces") && (
              <div className="more-switch">
                <Segmented label="More" value={tab} onChange={(next) => choose(next)}
                  options={[{ value: "report" as const, label: "Report" }, { value: "traces" as const, label: "Model calls" }]} />
              </div>
            )}
            {tab === "characters" && (inspected
              ? <Inspector worldId={worldId} view={view} characterId={inspected} onClose={() => setInspected(null)} />
              : <Characters worldId={worldId} view={view} run={run} onInspect={setInspected} onChange={live.setView} />)}
            {tab === "world" && <WorldPanel view={view} />}
            {tab === "setup" && <SetupEditor worldId={worldId} view={view} onSaved={live.setView} />}
            {tab === "report" && <ReportPanel worldId={worldId} revision={world.revision} />}
            {tab === "traces" && <TracesPanel worldId={worldId} revision={world.revision} />}
          </div>
        </aside>
      </div>
      <EditorPanel worldId={worldId} view={view} run={run} overlay={editor} onWorld={live.setView} />
      {narrow && (
        <>
          <nav className="bottom-tabs" aria-label="World sections">
            {BOTTOM.map((entry) => {
              const current = pane === entry.id || (entry.also !== undefined && pane === entry.also);
              const Icon = entry.icon;
              return (
                <button key={entry.id} type="button" aria-current={current ? "page" : undefined} onClick={() => choose(entry.id)}>
                  <Icon size={20} />{entry.label}
                </button>
              );
            })}
          </nav>
          {controls && (
            <SheetDialog name="run" title="Run the world" onClose={() => setControls(false)}>
              <Controls worldId={worldId} view={view} run={run} />
            </SheetDialog>
          )}
        </>
      )}
    </div>
  );
}
