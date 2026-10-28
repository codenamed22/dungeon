import { randomUUID } from "node:crypto";
import { openConfiguredEngine } from "./config.ts";
import { sampleWorld } from "./sample-world.ts";

const engine = await openConfiguredEngine();
try {
  const world = await engine.createWorld(sampleWorld());
  const result = await engine.execute(world.id, {
    role: "character",
    requestId: randomUUID(),
    expectedRevision: world.revision,
    actorId: "mira",
    action: { type: "wait", seconds: 60 },
  });
  const reconstructed = await engine.replayWorld(world.id);
  console.log(JSON.stringify({
    outcome: result.events,
    world: reconstructed,
    message: "Saved in PostgreSQL; event replay verified. Run again to resume this adventure.",
  }, null, 2));
} finally {
  await engine.close();
}
