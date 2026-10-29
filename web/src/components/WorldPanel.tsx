import { bandOf } from "../../../src/creator/operations.ts";
import { rulesOf } from "../../../src/model.ts";
import { clock, nameOf } from "../format.ts";
import type { WorldView } from "../types.ts";

/** The true state of the world: what the director knows and the characters may not. */
export function WorldPanel({ view }: { view: WorldView }) {
  const state = view.world;
  const rules = rulesOf(state);
  const here = (locationId: string) => state.characters.filter((character) => character.locationId === locationId && !character.away);
  const away = state.characters.filter((character) => character.away);
  const endings = state.endings ?? [];
  const pace = view.setup.cast.pace === "conversation" ? "conversation pace" : "action pace";
  return (
    <div className="stack">
      <p className="small muted">
        {rules.outcomes === "judgment" ? "The referee judges attempts" : "Dice decide attempts"} ·{" "}
        {rules.stats ? `stats ${rules.stats.strength}, ${rules.stats.dexterity}, ${rules.stats.wisdom}` : "no stats"} ·{" "}
        {rules.health ? `${rules.health} as health` : "no health"} · {pace}
      </p>
      <h3>Places</h3>
      {state.locations.map((location) => (
        <div key={location.id} className="sheet">
          <div className="row">
            <strong>{location.name}</strong>
            <span className="muted small grow right">{here(location.id).map((character) => character.name).join(", ") || "nobody"}</span>
          </div>
          {location.description && <div className="small">{location.description}</div>}
          <ul className="small plain">
            {location.routes.map((route) => (
              <li key={route.destinationId}>
                → {nameOf(state, route.destinationId)} <span className="muted">({Math.round(route.seconds / 60)} min)</span>
                {route.locked && <span className="tag">blocked</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {away.length > 0 && (
        <div className="sheet away small">
          <div className="row">
            <strong>Away from the scene</strong>
            <span className="muted grow right">{away.map((character) => character.name).join(", ")}</span>
          </div>
          <div className="muted">Nobody sees or hears them until the story or the director brings them in.</div>
        </div>
      )}
      <h3>Challenges</h3>
      {state.challenges.length === 0 && <p className="muted small">None.</p>}
      {state.challenges.map((challenge) => (
        <div key={challenge.id} className="sheet small">
          <div className="row">
            <strong>{challenge.name}</strong>
            {challenge.resolved && <span className="tag">resolved</span>}
            <span className="muted grow right">{nameOf(state, challenge.locationId)}</span>
          </div>
          {challenge.description && <div>{challenge.description}</div>}
          <div className="muted">
            {rules.outcomes === "judgment"
              ? `${bandOf(challenge.difficulty)}${rules.stats ? `, leans on ${rules.stats[challenge.ability]}` : ""}`
              : `${rules.stats?.[challenge.ability] ?? "d20"} vs ${challenge.difficulty}`}, {Math.round(challenge.seconds / 60)} min
            {challenge.failureDamage > 0 && `, ${challenge.failureDamage} damage on failure`}
            {challenge.requiresItemId && `, needs ${nameOf(state, challenge.requiresItemId)}`}
          </div>
          {challenge.criteria && <div className="muted">What it takes (only the referee reads this): {challenge.criteria}</div>}
          {challenge.onSuccess?.reveals && <div className="muted">Reveals to whoever succeeds: {challenge.onSuccess.reveals}</div>}
        </div>
      ))}
      <h3>Threats</h3>
      {(state.threats ?? []).length === 0 && <p className="muted small">None.</p>}
      {(state.threats ?? []).map((threat) => (
        <div key={threat.id} className="sheet small">
          <div className="row">
            <strong>{threat.name}</strong>
            <span className="tag">{threat.status}</span>
            <span className="muted grow right">
              {threat.status === "armed" && threat.at !== undefined && `fires at ${clock(threat.at)}`}
              {threat.status === "waiting" && threat.delaySeconds !== undefined && `${Math.round(threat.delaySeconds / 60)} min after it is set off`}
            </span>
          </div>
          <div>{threat.text}</div>
          <div className="muted">
            {threat.locationIds ? threat.locationIds.map((id) => nameOf(state, id)).join(", ") : "everywhere"}
            {threat.damage !== undefined && `, ${threat.damage} damage`}
            {(threat.enters ?? []).map((entry) => `, brings in ${nameOf(state, entry.characterId)} at ${nameOf(state, entry.locationId)}`).join("")}
            {(threat.exits ?? []).map((characterId) => `, sends away ${nameOf(state, characterId)}`).join("")}
          </div>
        </div>
      ))}
      {endings.length > 0 && (
        <>
          <h3>Endings</h3>
          {endings.map((ending) => (
            <div key={ending.id} className="sheet small">
              <div className="row">
                <strong>{ending.name}</strong>
                {state.endedWith === ending.id && <span className="tag">reached</span>}
                <span className="muted grow right">
                  {"threatId" in ending.when
                    ? `when ${nameOf(state, ending.when.threatId)} happens`
                    : `when ${nameOf(state, ending.when.challengeId)} ${ending.when.outcome === "success" ? "succeeds" : "fails"}`}
                </span>
              </div>
              <div>{ending.text}</div>
            </div>
          ))}
        </>
      )}
      <h3>Items</h3>
      <ul className="small plain">
        {state.items.map((item) => {
          const holders = state.characters.filter((character) => character.inventory[item.id]);
          return (
            <li key={item.id}>
              <strong>{item.name}</strong>
              <span className="muted"> · {holders.length > 0 ? holders.map((character) => character.name).join(", ") : "nobody has it"}</span>
              {item.description && <div className="muted">{item.description}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
