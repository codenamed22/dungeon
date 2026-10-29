import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, CircleAlert, Copy, Download, ExternalLink, Hammer, LoaderCircle, MapPin, RotateCcw, Users } from "lucide-react";
import { hasErrors, setWorld } from "../../../src/creator/operations.ts";
import { rulesOf } from "../../../src/model.ts";
import { api, errorText } from "../api.ts";
import { AssistantPanel } from "../creator/AssistantPanel.tsx";
import {
  ChallengesSection, CharactersSection, EndingsSection, ItemsSection, PlacesSection, ProblemList, StorySection, ThreatsSection,
} from "../creator/sections.tsx";
import type { SectionProps } from "../creator/sections.tsx";
import { refusal, useDraft } from "../creator/useDraft.ts";
import type { DraftEditor } from "../creator/useDraft.ts";
import { draftPath, navigate, worldPath } from "../router.ts";
import type { Draft, DraftSection } from "../types.ts";
import { Field, LiveText } from "../ui/controls.tsx";

type Tab = DraftSection | "review";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "story", label: "Story" },
  { id: "places", label: "Places" },
  { id: "characters", label: "Characters" },
  { id: "items", label: "Items" },
  { id: "challenges", label: "Challenges" },
  { id: "threats", label: "Threats" },
  { id: "endings", label: "Endings" },
  { id: "review", label: "Review" },
];

const SECTIONS: Record<DraftSection, (props: SectionProps) => ReactNode> = {
  story: StorySection,
  places: PlacesSection,
  characters: CharactersSection,
  items: ItemsSection,
  challenges: ChallengesSection,
  threats: ThreatsSection,
  endings: EndingsSection,
};

interface Toast {
  key: number;
  message: string;
  undo?: Draft;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function countOf(draft: Draft, tab: Tab): number | null {
  const { seed } = draft;
  switch (tab) {
    case "places": return seed.locations.length;
    case "characters": return seed.characters.length;
    case "items": return seed.items.length;
    case "challenges": return seed.challenges.length;
    case "threats": return seed.threats?.length ?? 0;
    case "endings": return seed.endings?.length ?? 0;
    default: return null;
  }
}

/** Takes ?assistant=1&prompt=… once, then drops it so a reload doesn't repeat it. */
function useLaunch(): { assistant: boolean; prompt: string } {
  const [launch] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { assistant: params.get("assistant") === "1", prompt: params.get("prompt") ?? "" };
  });
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, []);
  return launch;
}

export function Creator({ draftId }: { draftId: string }) {
  const editor = useDraft(draftId);
  const launch = useLaunch();
  const [tab, setTab] = useState<Tab>("story");
  const [focus, setFocus] = useState<SectionProps["focus"]>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { view, draft, problems } = editor;

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function showToast(message: string, undo?: Draft) {
    clearTimeout(toastTimer.current);
    setToast({ key: Date.now(), message, ...(undo ? { undo } : {}) });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 8000 : 4000);
  }

  function go(section: DraftSection, id?: string) {
    setTab(section);
    if (id) setFocus({ id, nonce: Date.now() });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const flags = useMemo(() => {
    const result = new Map<Tab, "error" | "warning">();
    for (const problem of problems) {
      if (problem.severity === "error" || !result.has(problem.section)) result.set(problem.section, problem.severity);
    }
    return result;
  }, [problems]);

  if (!view || !draft) {
    return (
      <main className="page">
        {editor.error ? <p className="error">{editor.error}</p> : <p className="muted"><LoaderCircle size={15} className="spin" /> Loading the draft…</p>}
      </main>
    );
  }

  const errors = problems.filter((problem) => problem.severity === "error").length;
  const published = view.publishedAt !== null;
  const Section = tab === "review" ? null : SECTIONS[tab];
  const sectionProps: SectionProps = { editor, draft, focus, onToast: showToast };

  return (
    <>
      <header className="creator-head">
        <div className="page">
          <span className="eyebrow">{published ? "World draft · became a world" : "World draft"}</span>
          <LiveText label={<span className="sr-only">Title</span>} value={draft.seed.name} maxLength={100} inputClassName="title-input" className="title-field"
            disabled={editor.readOnly} commit={(name) => refusal(editor.apply((current) => setWorld(current, { name })))} />
          <div className="meta-line">
            <span><MapPin size={13} />{plural(draft.seed.locations.length, "place")}</span>
            <span><Users size={13} />{plural(draft.seed.characters.length, "character")}</span>
            {errors > 0
              ? <button type="button" className="link small status bad" onClick={() => setTab("review")}>{plural(errors, "problem")}</button>
              : <span className="status good">Ready to play</span>}
            <SaveStatus editor={editor} />
          </div>
          <nav className="tabs" aria-label="Draft sections">
            {TABS.map((entry) => {
              const count = countOf(draft, entry.id);
              const flag = entry.id === "review" ? (errors > 0 ? "error" : undefined) : flags.get(entry.id);
              return (
                <button key={entry.id} type="button" className={`tab ${tab === entry.id ? "active" : ""}`} aria-current={tab === entry.id ? "page" : undefined}
                  onClick={() => setTab(entry.id)}>
                  {entry.label}
                  {count !== null && <span className="count">{count}</span>}
                  {flag && <span className={`flag ${flag === "warning" ? "warn" : ""}`} aria-label={flag === "error" ? "has problems" : "has suggestions"} />}
                </button>
              );
            })}
          </nav>
        </div>
      </header>
      <main className={`creator-body ${editor.readOnly ? "readonly" : ""}`}>
        {editor.error && (
          <div className="notice" role="alert">
            <CircleAlert size={16} />
            <span className="grow">{editor.error}</span>
            <button type="button" className="small" onClick={() => void editor.reload()}><RotateCcw size={14} />Reload</button>
          </div>
        )}
        {published && tab !== "review" && (
          <p className="notice"><CircleAlert size={16} />This draft became the world {view.worldId} and can no longer change. Copy it to a new draft on the Review tab to change it.</p>
        )}
        {Section ? <Section {...sectionProps} /> : <Review editor={editor} draftId={draftId} onGo={go} />}
      </main>
      {!published && <AssistantPanel editor={editor} draftId={draftId} launch={launch} />}
      {toast && (
        <div key={toast.key} className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button type="button" onClick={() => {
              editor.restore(toast.undo!);
              setToast(null);
            }}>Undo</button>
          )}
        </div>
      )}
    </>
  );
}

function SaveStatus({ editor }: { editor: DraftEditor }) {
  if (editor.view?.busy || (editor.readOnly && editor.view?.publishedAt === null)) return <span className="status busy pulse">The AI creator is working</span>;
  switch (editor.saveState) {
    case "saving": return <span className="status busy pulse">Saving</span>;
    case "unsaved": return <span className="status quiet">Unsaved</span>;
    case "failed": return <span className="status bad">Not saved</span>;
    default: return <span className="status good">Saved</span>;
  }
}

function Review({ editor, draftId, onGo }: { editor: DraftEditor; draftId: string; onGo(section: DraftSection, id?: string): void }) {
  const view = editor.view!;
  const draft = editor.draft!;
  const { seed, cast } = draft;
  const [worldId, setWorldId] = useState(view.suggestedWorldId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const published = view.publishedAt !== null;
  const blocked = hasErrors(editor.problems);
  const warnings = editor.problems.filter((problem) => problem.severity === "warning").length;

  useEffect(() => setWorldId(view.suggestedWorldId), [view.suggestedWorldId]);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const saved = await editor.flush();
      editor.adopt(await api.publishDraft(draftId, worldId.trim(), saved.revision));
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  }

  /** Saves the draft's design to a file, after any unsaved change. */
  async function download() {
    setError(null);
    try {
      await editor.flush();
      await api.exportDraft(draftId);
    } catch (problem) {
      setError(errorText(problem));
    }
  }

  async function copy() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createDraft({ name: `${seed.name} (copy)` });
      await api.saveDraft(created.id, { ...draft, seed: { ...seed, name: `${seed.name} (copy)` } }, created.revision);
      navigate(draftPath(created.id));
    } catch (problem) {
      setError(errorText(problem));
      setBusy(false);
    }
  }

  const main = seed.characters.filter((character) => !character.npc);
  const voiced = seed.characters.filter((character) => (character.npc ? cast.npcs?.[character.id] : cast.characters[character.id]));
  const rules = rulesOf(seed);
  const stats: [string, string][] = [
    ["Attempts decided by", rules.outcomes === "judgment" ? "AI judgment" : "Dice"],
    ["Stats", rules.stats ? `${rules.stats.strength}, ${rules.stats.dexterity}, ${rules.stats.wisdom}` : "None"],
    ["Health", rules.health ?? "None"],
    ["Pace", cast.pace === "conversation" ? "Conversation" : "Action"],
    ["Places", String(seed.locations.length)],
    ["Ways between them", String(seed.locations.reduce((sum, location) => sum + location.routes.length, 0))],
    ["Main characters", String(main.length)],
    ["Supporting characters", String(seed.characters.length - main.length)],
    ["With a persona", `${voiced.length} of ${seed.characters.length}`],
    ["Items", String(seed.items.length)],
    ["Challenges", String(seed.challenges.length)],
    ["Threats", String(seed.threats?.length ?? 0)],
    ["Endings", String(seed.endings?.length ?? 0)],
  ];
  // Model choices arrive only with an imported file; the world starts with them.
  const models = draft.models;
  const modelText = [
    models?.character && `characters ${models.character}${models.characterEffort ? ` (${models.characterEffort} effort)` : ""}`,
    models?.dm && `game master ${models.dm}${models.dmEffort ? ` (${models.dmEffort} effort)` : ""}`,
  ].filter(Boolean).join("; ");

  return (
    <div className="stack" style={{ gap: 22 }}>
      <section className="stack">
        <h2 className="section-title">{blocked ? "Fix these to create the world" : editor.problems.length ? "Ready, with suggestions" : "Ready to play"}</h2>
        {editor.problems.length === 0
          ? <p className="muted"><Check size={15} /> Nothing missing: every place is reachable, everyone has a persona, and there is a premise.</p>
          : <ProblemList problems={editor.problems} onGo={onGo} />}
        {!blocked && warnings > 0 && <p className="muted small">Suggestions don't stop you creating the world.</p>}
      </section>
      <section>
        <h2 className="section-title">In this world</h2>
        <dl className="stats">
          {stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {modelText && <p className="muted small">Models from the imported file: {modelText}. You can change them under Agents once the world exists.</p>}
        <div className="row wrap">
          <button type="button" className="small" onClick={() => void download()} title="Save this draft's design to a file, to keep, share, or import elsewhere">
            <Download size={14} />Download design
          </button>
        </div>
      </section>
      {published ? (
        <section className="publish-bar">
          <div className="grow">
            <strong>This draft became the world {view.worldId}.</strong>
            <p className="muted small" style={{ margin: "4px 0 0" }}>The draft can no longer change. Copy it to make a new version.</p>
          </div>
          <button type="button" disabled={busy} onClick={() => void copy()}><Copy size={15} />Copy to a new draft</button>
          <button type="button" className="primary" onClick={() => navigate(worldPath(view.worldId!))}><ExternalLink size={15} />Open world</button>
        </section>
      ) : (
        <section className="publish-bar">
          <Field label="World ID" hint="Letters, digits, hyphens, and underscores; it appears in the world's address.">
            <input value={worldId} onChange={(event) => setWorldId(event.target.value)} maxLength={64} spellCheck={false} autoCapitalize="off" />
          </Field>
          <button type="button" className="primary" disabled={busy || blocked || editor.readOnly || !worldId.trim()} onClick={() => void publish()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Hammer size={15} />}Create world
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
