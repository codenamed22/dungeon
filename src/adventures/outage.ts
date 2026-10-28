import type { Cast } from "../agents/prompts.ts";
import type { WorldSeed } from "../model.ts";

// Two engineers diagnose a failure under time pressure. Places are the
// consoles they can open, and the only item is access. No stats and no
// health: the referee judges each step against what it takes, and the clues
// sit in private discoveries. The incident commander's theory is wrong, and
// acting on it makes things worse.
export function outageWorld(id = "outage"): WorldSeed {
  return {
    id,
    name: "The 3 A.M. Outage",
    speechSeconds: 10,
    rules: { outcomes: "judgment", stats: null, health: null },
    rulings: { abilities: ["wisdom"], maxDifficulty: "hard", maxFailureDamage: 0, maxSeconds: 600 },
    locations: [
      {
        id: "war-room",
        name: "Incident bridge",
        description: "The incident video call and its chat channel: a wall of red alerts, a status page draft, and Morgan's camera.",
        routes: [
          { destinationId: "logs", seconds: 60 },
          { destinationId: "database", seconds: 60 },
          { destinationId: "deploys", seconds: 60 },
          { destinationId: "gateway", seconds: 60 },
        ],
      },
      {
        id: "logs",
        name: "Log search",
        description: "The log search console, with millions of lines since 03:00 and a query box.",
        routes: [{ destinationId: "war-room", seconds: 60 }],
      },
      {
        id: "database",
        name: "Database console",
        description: "Connection graphs, replication lag, and slow-query lists for the payments database.",
        routes: [{ destinationId: "war-room", seconds: 60 }],
      },
      {
        id: "deploys",
        name: "Deploy pipeline",
        description: "The deploy history. Last night's 02:45 release of the checkout service sits at the top, marked green.",
        routes: [{ destinationId: "war-room", seconds: 60 }],
      },
      {
        id: "gateway",
        name: "Gateway console",
        description: "The edge gateway in front of the payments API: its routes, certificates, and a reload button behind admin access.",
        routes: [{ destinationId: "war-room", seconds: 60 }],
      },
    ],
    items: [
      { id: "admin-token", name: "Break-glass admin token", description: "Temporary admin access to production infrastructure, logged and audited." },
    ],
    characters: [
      { id: "priya", name: "Priya", locationId: "war-room", hp: 10, maxHp: 10, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
      { id: "dan", name: "Dan", locationId: "war-room", hp: 10, maxHp: 10, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
      { id: "morgan", name: "Morgan", locationId: "war-room", hp: 10, maxHp: 10, npc: true, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
      { id: "wen", name: "Wen", locationId: "database", hp: 10, maxHp: 10, npc: true, modifiers: { strength: 0, dexterity: 0, wisdom: 0 }, inventory: {} },
    ],
    challenges: [
      {
        id: "search-logs",
        name: "Search the error logs",
        description: "Every service is logging something. The trick is finding the first thing that went wrong.",
        locationId: "logs",
        ability: "wisdom", difficulty: 12, seconds: 300, failureDamage: 0,
        criteria: "Succeeds if they narrow the search by time (around 02:58, when checkout started failing) and by the checkout "
          + "service or its errors. Fails if they search everything at once, or only look after 03:00.",
        onSuccess: {
          reveals: "At 02:58:03 the checkout service starts logging \"x509: certificate has expired or is not yet valid\" on every "
            + "call to the payments gateway. Nothing in checkout's own errors changed before that, deploy or no deploy.",
        },
        resolved: false,
      },
      {
        id: "inspect-certificate",
        name: "Inspect the gateway's certificate",
        description: "The gateway presents a TLS certificate to everything that calls it.",
        locationId: "gateway",
        ability: "wisdom", difficulty: 8, seconds: 180, failureDamage: 0,
        criteria: "Succeeds if they look at the certificate the gateway serves (its validity dates, or its renewal history). Fails "
          + "if they only look at traffic graphs or restart things.",
        onSuccess: {
          reveals: "The gateway's certificate for api.payments.internal expired at 02:58 UTC. Automatic renewal has failed every "
            + "night for 30 days: its DNS check points at a zone that no longer exists.",
        },
        resolved: false,
      },
      {
        id: "check-database",
        name: "Check the database",
        description: "Connection counts spiked at 03:00.",
        locationId: "database",
        ability: "wisdom", difficulty: 8, seconds: 240, failureDamage: 0,
        criteria: "Succeeds with any sensible look at connections, errors, and replication. Fails only if they change something "
          + "instead of looking.",
        onSuccess: {
          reveals: "The database is healthy. The connection spike is clients reconnecting after failed calls upstream, not the "
            + "database refusing them.",
        },
        resolved: false,
      },
      {
        id: "rollback",
        name: "Roll back the 02:45 deploy",
        description: "One click puts the previous checkout release back.",
        locationId: "deploys",
        ability: "wisdom", difficulty: 8, seconds: 240, failureDamage: 0,
        criteria: "The rollback runs if they choose the previous release and confirm. It fails only if they pick the wrong "
          + "release or abandon it halfway. Whether it helps is another matter.",
        onSuccess: { armThreats: ["retry-storm"] },
        resolved: false,
      },
      {
        id: "get-access",
        name: "Get break-glass access",
        description: "Admin access to the gateway needs the incident commander's approval.",
        locationId: "war-room",
        ability: "wisdom", difficulty: 12, seconds: 180, failureDamage: 0,
        criteria: "Succeeds if they ask Morgan for gateway admin access and justify it with evidence they have actually found, "
          + "such as the certificate errors in the logs or the expired certificate. Fails on \"trust me\", on vague hunches, or "
          + "if Morgan is not on the bridge.",
        onSuccess: { grantItems: [{ itemId: "admin-token", quantity: 1 }] },
        resolved: false,
      },
      {
        id: "rotate-certificate",
        name: "Rotate the gateway certificate",
        description: "Issue a new certificate and reload the gateway.",
        locationId: "gateway",
        ability: "wisdom", difficulty: 16, seconds: 420, failureDamage: 0,
        requiresItemId: "admin-token",
        criteria: "Succeeds only if the one attempting it has found the expired certificate themselves, or has been told about it "
          + "by someone who found it, and they both issue a new certificate and reload the gateway. Fails if they only restart "
          + "the gateway, or skip the reload.",
        resolved: false,
      },
    ],
    threats: [
      {
        id: "social-media",
        name: "Social media notices",
        text: "Morgan pastes a screenshot into the channel: customers are posting that checkout is broken, and a reporter has asked "
          + "for comment.",
        locationIds: ["war-room"],
        status: "armed",
        at: 1200,
      },
      {
        id: "vp-joins",
        name: "The VP joins",
        text: "The VP of Engineering joins the call, camera on: \"I need a cause and an ETA in ten minutes.\"",
        locationIds: ["war-room"],
        status: "armed",
        at: 2100,
      },
      {
        id: "retry-storm",
        name: "It gets worse",
        text: "Every dashboard goes red at once: the rollback restarted every checkout server together, and their retries are "
          + "flooding the database. Its console stops responding.",
        lockRoutes: [{ fromId: "war-room", destinationId: "database" }],
        status: "waiting",
        delaySeconds: 180,
      },
      {
        id: "morning-traffic",
        name: "Morning traffic",
        text: "The East Coast wakes up. Traffic triples, and the status page flips to \"Major outage\".",
        status: "armed",
        at: 3600,
      },
    ],
    endings: [
      {
        id: "restored",
        name: "Restored",
        text: "The gateway reloads with a fresh certificate. Within a minute the error graph drops to zero and orders flow again. "
          + "Morgan writes \"Mitigated\" in the channel, and someone files a ticket to fix the renewal job.",
        when: { challengeId: "rotate-certificate", outcome: "success" },
      },
      {
        id: "full-outage",
        name: "Full outage",
        text: "Morning traffic hits a payment system that still cannot take payments. The postmortem will be long, and it will "
          + "start with the words \"certificate expired\".",
        when: { threatId: "morning-traffic" },
      },
    ],
  };
}

export const outageCast: Cast = {
  premise: "A payments company at 3 a.m. Checkout has failed for every customer since 02:58. Two on-call engineers have joined "
    + "the incident call from their kitchens to find the cause and restore service before morning traffic arrives. The places "
    + "are the consoles and dashboards they can open; access is the only thing they carry. Realistic and technical, with no "
    + "physical danger.",
  narratorStyle: "Terse and precise, like a good incident log, with the occasional human detail. Present tense.",
  pace: "action",
  characters: {
    priya: {
      summary: "A site reliability engineer, five years on call. Trusts evidence over theories and timestamps over everything.",
      voice: "Calm, clipped, asks for specifics.",
      goals: ["Find what changed at 02:58", "Restore checkout before morning traffic"],
      riskTolerance: "cautious",
    },
    dan: {
      summary: "A backend engineer who owns the checkout service and shipped last night's 02:45 release. Worried it was his fault.",
      voice: "Fast, a bit anxious, thinks aloud.",
      goals: ["Prove or rule out the 02:45 deploy", "Get checkout working again"],
      riskTolerance: "bold",
    },
  },
  npcs: {
    morgan: {
      summary: "The incident commander tonight: decisive, under pressure from above, and sure it was the deploy.",
      voice: "Short sentences. Wants a cause and an ETA.",
      knowledge: [
        "The 02:45 checkout release is the only change tonight, so it must be the cause; only hard evidence will change your mind",
        "Break-glass admin access to production is yours to approve, but only with a real reason",
      ],
      wants: ["A rollback, now", "A cause and an ETA for the VP"],
      agenda: { everyMinutes: 10, aims: ["Push for rolling back the 02:45 deploy", "Ask for an ETA"] },
    },
    wen: {
      summary: "The database engineer on call, half awake, watching connection graphs.",
      voice: "Sleepy, dry, precise about her own systems.",
      knowledge: [
        "The database is fine; the spike is clients reconnecting since about 02:58",
        "Last month someone deleted old DNS zones in a cleanup (she does not connect this to tonight)",
      ],
      wants: ["To prove it isn't the database", "To go back to bed"],
    },
  },
};
