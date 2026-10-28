import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { draftProblems } from "../../../src/creator/operations.ts";
import type { OperationResult } from "../../../src/creator/operations.ts";
import { api, ApiError, errorText } from "../api.ts";
import type { Draft, DraftProblem, DraftView } from "../types.ts";

export type SaveState = "saved" | "saving" | "unsaved" | "failed";

/** The refusal in an operation's outcome, if any: what a live field shows. */
export function refusal(outcome: OperationResult | string): string | null {
  return typeof outcome === "string" ? outcome : null;
}

export interface DraftEditor {
  view: DraftView | null;
  /** The working copy, which may be ahead of the saved one. */
  draft: Draft | null;
  problems: DraftProblem[];
  saveState: SaveState;
  error: string | null;
  /** Published, or the AI creator is working on it. */
  readOnly: boolean;
  /** Applies an operation now and saves soon. Returns its result, or why it was refused. */
  apply(edit: (draft: Draft) => OperationResult): OperationResult | string;
  /** Puts back an earlier working copy, as an Undo does. */
  restore(draft: Draft): void;
  /** Saves any pending change now, and returns the saved view. */
  flush(): Promise<DraftView>;
  /** Takes a newer view from the server, after the AI creator, an undo, or publishing. */
  adopt(view: DraftView): void;
  /** Shows a change the AI creator just saved, while it is still working. */
  follow(draft: Draft, revision: number): void;
  setAssisting(assisting: boolean): void;
  reload(): Promise<void>;
}

const SAVE_DELAY_MS = 600;

function describeSaveError(problem: unknown): string {
  if (problem instanceof ApiError && problem.code === "STALE_REVISION") {
    return "This draft changed somewhere else, perhaps in another tab. Reload to see the latest version; your last change here is not saved.";
  }
  if (problem instanceof ApiError && problem.code === "DRAFT_BUSY") return "The AI creator is working on this draft. Your change is not saved.";
  return `Not saved: ${errorText(problem)}`;
}

/**
 * A draft open in the creator. Edits apply locally at once, through the same
 * operations the AI uses, and are saved after a short pause with the revision
 * they were made on, so a change made elsewhere is never silently overwritten.
 */
export function useDraft(draftId: string): DraftEditor {
  const [view, setView] = useState<DraftView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [assisting, setAssisting] = useState(false);
  const latest = useRef<{ draft: Draft | null; revision: number; dirty: boolean }>({ draft: null, revision: 0, dirty: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const viewRef = useRef<DraftView | null>(null);

  const adopt = useCallback((next: DraftView) => {
    clearTimeout(timer.current);
    latest.current = { draft: next.draft, revision: next.revision, dirty: false };
    viewRef.current = next;
    setView(next);
    setDraft(next.draft);
    setSaveState("saved");
    setError(null);
  }, []);

  const follow = useCallback((next: Draft, revision: number) => {
    latest.current = { draft: next, revision, dirty: false };
    setDraft(next);
  }, []);

  const reload = useCallback(async () => {
    try {
      adopt(await api.draft(draftId));
    } catch (problem) {
      setError(errorText(problem));
    }
  }, [draftId, adopt]);

  useEffect(() => {
    void reload();
    return () => clearTimeout(timer.current);
  }, [reload]);

  const saveOnce = useCallback(async () => {
    const sent = latest.current.draft;
    if (!sent || !latest.current.dirty) return;
    setSaveState("saving");
    try {
      const saved = await api.saveDraft(draftId, sent, latest.current.revision);
      latest.current.revision = saved.revision;
      viewRef.current = saved;
      setView(saved);
      if (latest.current.draft === sent) {
        latest.current.dirty = false;
        setSaveState("saved");
      }
      setError(null);
    } catch (problem) {
      setSaveState("failed");
      setError(describeSaveError(problem));
      throw problem;
    }
  }, [draftId]);

  const flush = useCallback(async (): Promise<DraftView> => {
    clearTimeout(timer.current);
    // Edits made while a save is under way need one more.
    while (saving.current || latest.current.dirty) {
      if (!saving.current) saving.current = saveOnce().finally(() => { saving.current = null; });
      await saving.current;
    }
    return viewRef.current!;
  }, [saveOnce]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush().catch(() => {}); }, SAVE_DELAY_MS);
  }, [flush]);

  const readOnly = view?.publishedAt != null || assisting;

  const restore = useCallback((next: Draft) => {
    latest.current.draft = next;
    latest.current.dirty = true;
    setDraft(next);
    setSaveState("unsaved");
    schedule();
  }, [schedule]);

  const apply = useCallback((edit: (draft: Draft) => OperationResult): OperationResult | string => {
    const current = latest.current.draft;
    if (!current) return "The draft has not loaded yet.";
    if (readOnly) return assisting ? "The AI creator is working; wait for it or stop it." : "This draft has become a world and can no longer change.";
    let result: OperationResult;
    try {
      result = edit(current);
    } catch (problem) {
      return errorText(problem);
    }
    restore(result.draft);
    return result;
  }, [readOnly, assisting, restore]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const problems = useMemo(() => (draft ? draftProblems(draft) : []), [draft]);
  return { view, draft, problems, saveState, error, readOnly, apply, restore, flush, adopt, follow, setAssisting, reload };
}
