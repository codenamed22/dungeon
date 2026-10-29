import { useEffect, useState } from "react";
import { Check, Wrench, X } from "lucide-react";
import { api, errorText } from "../api.ts";
import type { CreatorUsage, ModelInfo, ToolLine } from "../types.ts";

// Pieces the AI creator and the story editor share.

export const money = (cost: number) => (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);

export function usageText(usage: CreatorUsage): string {
  const tokens = `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`;
  return usage.cost === null ? tokens : `${money(usage.cost)} · ${tokens}`;
}

/** What several messages cost together; null if any did not report it. */
export function totalCost(usages: readonly CreatorUsage[]): number | null {
  if (usages.length === 0 || usages.some((usage) => usage.cost === null)) return null;
  return usages.reduce((sum, usage) => sum + (usage.cost ?? 0), 0);
}

export function ToolRow({ line }: { line: ToolLine }) {
  return (
    <p className={`tool-line ${line.ok ? "" : "failed"}`}>
      {line.ok ? <Wrench size={12} /> : <X size={12} />}
      <span>{line.summary}</span>
    </p>
  );
}

export function ModelPicker({ title, current, fallback, onPick, onClose }: {
  title: string; current: string; fallback: string | null; onPick(id: string): void; onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      api.models(query)
        .then((found) => { setModels(found.filter((model) => model.tools)); setError(null); })
        .catch((problem) => setError(errorText(problem)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <div className="model-picker">
      <div className="row">
        <strong className="grow small">{title}</strong>
        <button type="button" className="icon-button" aria-label="Close the model list" onClick={onClose}><X size={16} /></button>
      </div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models that can call tools" aria-label="Search models" autoFocus />
      {error && <p className="error small">{error}</p>}
      <ul className="model-results">
        <li>
          <button type="button" className="link small" onClick={() => onPick("")}>
            {current === "" && <Check size={12} />} The server's default{fallback ? ` (${fallback})` : ""}
          </button>
        </li>
        {models === null && <li className="muted small">Loading…</li>}
        {models?.length === 0 && <li className="muted small">No model that can call tools matches.</li>}
        {models?.map((model) => (
          <li key={model.id}>
            <button type="button" className="link small" onClick={() => onPick(model.id)}>
              {current === model.id && <Check size={12} />} {model.id}
            </button>
            {model.promptPerMillion !== null && model.completionPerMillion !== null && (
              <span className="muted small"> · ${model.promptPerMillion.toFixed(2)} / ${model.completionPerMillion.toFixed(2)} per M tokens</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
