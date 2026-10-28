import { useEffect, useState } from "react";
import { api, errorText } from "../api.ts";
import { credits } from "../format.ts";
import type { MetricsReport } from "../types.ts";

const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);
const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);

/** How the session is going: turns, stalls, rulings, and what the models cost. */
export function ReportPanel({ worldId, revision }: { worldId: string; revision: number }) {
  const [report, setReport] = useState<MetricsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.report(worldId)
      .then((next) => { if (current) { setReport(next); setError(null); } })
      .catch((problem) => { if (current) setError(errorText(problem)); });
    return () => { current = false; };
  }, [worldId, revision]);

  if (error) return <p className="error small">{error}</p>;
  if (!report) return <p className="muted small">Loading…</p>;
  const rows: [string, string][] = [
    ["Character turns", String(report.characterTurns)],
    ["Supporting character turns", String(report.npcTurns)],
    ["Turns to first action", report.turnsToFirstAction === null ? "no action yet" : String(report.turnsToFirstAction)],
    ["Longest talk without action", `${report.longestStall} turn(s)`],
    ["Threats fired", String(report.threatsFired)],
    ["Steering requests", String(report.steeringRequests)],
    ["Rulings", `${report.rulings.existing} existing, ${report.rulings.new} new, ${report.rulings.automatic} automatic, ${report.rulings.impossible} impossible`],
    ["Invalid proposals", percent(report.invalidProposalRate)],
    ["Model calls", `${report.calls}, ${report.tokens} tokens`],
    ["Cost", report.cost === null ? "not reported" : `${credits(report.cost)} credits`],
    ["Cost per turn", report.costPerTurn === null ? "–" : `${credits(report.costPerTurn)} credits`],
    ["Model time per turn", seconds(report.latencyPerTurnMs)],
  ];
  return (
    <div className="stack">
      <table className="facts">
        <tbody>{rows.map(([label, value]) => <tr key={label}><th>{label}</th><td>{value}</td></tr>)}</tbody>
      </table>
      {Object.keys(report.turnsByActor).length > 0 && (
        <>
          <h3>Turns by character</h3>
          <table className="facts">
            <tbody>
              {Object.entries(report.turnsByActor).map(([actor, turns]) => <tr key={actor}><th>{actor}</th><td>{turns}</td></tr>)}
            </tbody>
          </table>
        </>
      )}
      {report.tasks.some((task) => task.calls > 0) && (
        <>
          <h3>By task</h3>
          <table className="grid">
            <thead><tr><th>Task</th><th>Calls</th><th>Invalid</th><th>Errors</th><th>Tokens</th><th>Credits</th><th>Mean time</th></tr></thead>
            <tbody>
              {report.tasks.filter((task) => task.calls > 0).map((task) => (
                <tr key={task.task}>
                  <td>{task.task.replace("_", " ")}</td>
                  <td>{task.calls}</td>
                  <td>{task.invalid}</td>
                  <td>{task.providerErrors}</td>
                  <td>{task.tokens}</td>
                  <td>{credits(task.cost)}</td>
                  <td>{seconds(task.meanLatencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
