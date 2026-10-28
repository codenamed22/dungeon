import type { Cast } from "../agents/prompts.ts";
import type { WorldSeed } from "../model.ts";

// A friendship-or-more story with no peril: the referee judges what works,
// stats are Charm, Wit, and Empathy, and nobody can be hurt. Alex means to
// confess tonight; Sam has news they have not shared. Jordan's arrival forces
// the news out unless Sam tells it first, and the last ferry ends the night.
export function nightMarketWorld(id = "night-market"): WorldSeed {
  return {
    id,
    name: "The Night Market",
    speechSeconds: 10,
    rules: { outcomes: "judgment", stats: { strength: "Charm", dexterity: "Wit", wisdom: "Empathy" }, health: null },
    rulings: { abilities: ["strength", "dexterity", "wisdom"], maxDifficulty: "hard", maxFailureDamage: 0, maxSeconds: 600 },
    locations: [
      {
        id: "gate",
        name: "Market Gate",
        description: "Strings of paper lanterns over a crowded entrance. A ring-toss stall promises prizes; the river glints beyond the stalls.",
        routes: [{ destinationId: "row", seconds: 180 }, { destinationId: "pier", seconds: 480 }],
      },
      {
        id: "row",
        name: "Dumpling Row",
        description: "Steam, sizzling oil, and Mei's stall at the end, with two stools at the counter.",
        routes: [{ destinationId: "gate", seconds: 180 }, { destinationId: "bridge", seconds: 240 }],
      },
      {
        id: "bridge",
        name: "Lantern Bridge",
        description: "A quiet footbridge over the river, away from the noise. People release wish lanterns from its rail.",
        routes: [{ destinationId: "row", seconds: 240 }, { destinationId: "pier", seconds: 300 }],
      },
      {
        id: "pier",
        name: "Ferry Pier",
        description: "Wooden boards, a timetable board, and a small crowd waiting for the last ferry across the river.",
        routes: [{ destinationId: "bridge", seconds: 300 }, { destinationId: "gate", seconds: 480 }],
      },
    ],
    items: [
      { id: "ferry-tickets", name: "Ferry tickets", description: "Two return tickets for the last ferry." },
      { id: "wish-lantern", name: "Wish lantern", description: "A folded paper lantern with a little card for writing a wish." },
    ],
    characters: [
      {
        id: "alex", name: "Alex", locationId: "gate", hp: 10, maxHp: 10,
        modifiers: { strength: 1, dexterity: 2, wisdom: 0 },
        inventory: { "ferry-tickets": 1 },
      },
      {
        id: "sam", name: "Sam", locationId: "gate", hp: 10, maxHp: 10,
        modifiers: { strength: 1, dexterity: 0, wisdom: 2 },
        inventory: {},
      },
      {
        id: "mei", name: "Mei", locationId: "row", hp: 10, maxHp: 10, npc: true,
        modifiers: { strength: 0, dexterity: 1, wisdom: 2 },
        inventory: {},
      },
      {
        id: "jordan", name: "Jordan", locationId: "pier", hp: 10, maxHp: 10, npc: true,
        modifiers: { strength: 2, dexterity: 1, wisdom: 0 },
        inventory: {},
      },
    ],
    challenges: [
      {
        id: "ring-toss",
        name: "Win at the ring toss",
        description: "Three rings for a coin. The top prize is a wish lantern, and the stall keeper is enjoying the crowd.",
        locationId: "gate",
        ability: "dexterity", difficulty: 12, seconds: 180, failureDamage: 0,
        criteria: "Works with a calm, unhurried throw, or by getting the stall keeper laughing enough to allow a fourth ring. "
          + "Fails if they show off, rush, or argue with the keeper.",
        onSuccess: { grantItems: [{ itemId: "wish-lantern", quantity: 1 }] },
        resolved: false,
      },
      {
        id: "ask-mei",
        name: "Ask Mei what is going on with Sam",
        description: "Mei has known Sam since school and misses nothing.",
        locationId: "row",
        ability: "wisdom", difficulty: 12, seconds: 300, failureDamage: 0,
        criteria: "Succeeds if they ask kindly and directly, say that Sam has seemed distracted lately, and buy something or help "
          + "at the stall. Fails if they gossip, pry for details, or ask while Sam is listening.",
        onSuccess: {
          reveals: "Mei lowers her voice: Sam has been offered a job in Lisbon and must answer by Monday. Sam has not told anyone, "
            + "and Mei thinks it is because of you.",
        },
        resolved: false,
      },
      {
        id: "release-lantern",
        name: "Release a wish lantern together",
        description: "Lanterns drift up from the rail, each carrying someone's written wish.",
        locationId: "bridge",
        ability: "wisdom", difficulty: 8, seconds: 240, failureDamage: 0,
        requiresItemId: "wish-lantern",
        criteria: "Works when both Alex and Sam are on the bridge, each writes a wish, and they let it go together. Fails if it "
          + "is treated as a joke or done alone.",
        onSuccess: { reveals: "As the lantern rises, you catch the other one watching you instead of the sky." },
        resolved: false,
      },
      {
        id: "tell-alex",
        name: "Tell Alex about Lisbon",
        description: "Some news is easier to share somewhere quiet.",
        locationId: "bridge",
        ability: "wisdom", difficulty: 12, seconds: 300, failureDamage: 0,
        criteria: "Only Sam can do this. Succeeds if Sam tells Alex plainly about the job in Lisbon, says when the answer is due, "
          + "and asks what Alex thinks. Fails if Sam downplays it, jokes it away, or tells it in front of Jordan.",
        onSuccess: { disarmThreats: ["jordan-arrives"] },
        resolved: false,
      },
      {
        id: "confess",
        name: "Tell Sam how you feel",
        description: "The bridge is quiet enough to say anything.",
        locationId: "bridge",
        ability: "strength", difficulty: 16, seconds: 300, failureDamage: 0,
        criteria: "Only Alex can do this. Succeeds only if Alex says plainly, in their own words, that they have feelings for Sam, "
          + "and has first asked what is on Sam's mind or responded honestly to the Lisbon news. Fails if it is a hint or a joke, "
          + "if Jordan is there, or if Alex has not listened to Sam at all tonight.",
        resolved: false,
      },
    ],
    threats: [
      {
        id: "jordan-arrives",
        name: "Jordan lets the news slip",
        text: "Jordan's voice carries over the crowd: \"Sam! Is it true you're moving to Lisbon? Were you going to tell anyone?\"",
        status: "armed",
        at: 2700,
      },
      {
        id: "last-ferry",
        name: "The last ferry",
        text: "A horn sounds from the pier: the last ferry is leaving, and the stalls begin to pull down their shutters.",
        status: "armed",
        at: 5400,
      },
    ],
    endings: [
      {
        id: "together",
        name: "Together",
        text: "Sam laughs, then doesn't, and says \"me too\". The ferry horn sounds and neither of them moves. Lisbon is a "
          + "problem for Monday.",
        when: { challengeId: "confess", outcome: "success" },
      },
      {
        id: "still-friends",
        name: "Still friends",
        text: "Sam squeezes Alex's hand, gently, and says they need time. They walk to the pier together, close but not quite "
          + "touching, and talk about anything else.",
        when: { challengeId: "confess", outcome: "failure" },
      },
      {
        id: "night-ends",
        name: "The night ends",
        text: "The market goes dark around them. Whatever was going to be said tonight stays unsaid, for now.",
        when: { threatId: "last-ferry" },
      },
    ],
  };
}

export const nightMarketCast: Cast = {
  premise: "A riverside night market in a modern city, on a warm Friday in early summer. Alex and Sam have been best friends since "
    + "university and come here every year. Tonight feels different to both of them. A gentle story about friendship, honesty, "
    + "and maybe more; nobody is in danger, and the market closes when the last ferry leaves.",
  narratorStyle: "Warm, observant, and light, with small sensory details. Present tense.",
  pace: "conversation",
  characters: {
    alex: {
      summary: "A graphic designer who is funny in groups and tongue-tied alone. Alex has been in love with Sam for a year.",
      voice: "Quick and self-deprecating; jokes when nervous.",
      goals: ["Tell Sam how you feel before the night ends", "Find out why Sam has seemed far away lately"],
      riskTolerance: "cautious",
    },
    sam: {
      summary: "A nurse, steady and kind, who has been offered a job in Lisbon and must answer by Monday. Sam has not told Alex, "
        + "because Alex is the reason Sam might say no.",
      voice: "Warm, direct, a little dry; goes quiet when something matters.",
      goals: ["Tell Alex about Lisbon yourself, before someone else does", "Work out whether there is a reason to stay"],
      riskTolerance: "balanced",
    },
  },
  npcs: {
    mei: {
      summary: "Runs the dumpling stall at the end of the row and has known Sam since school.",
      voice: "Brisk and teasing, with a soft spot she hides badly.",
      knowledge: [
        "Sam has been offered a job in Lisbon and must answer by Monday",
        "Sam has not told Alex, and you suspect Sam is waiting for a reason to stay",
        "The ring-toss keeper lets people have a fourth ring if they make him laugh",
      ],
      wants: ["Sam to be happy, whatever that means", "Customers who actually buy something"],
    },
    jordan: {
      summary: "Sam's old flatmate: loud, generous, and always arranging something.",
      voice: "Enthusiastic, a bit too loud, full of plans.",
      knowledge: [
        "Sam is moving to Lisbon: Sam mentioned the offer, and you assume it is settled",
        "There is a party on a boat at the pier later, and everyone should come",
      ],
      wants: ["Get Sam and Alex to come to the boat party", "Throw Sam a goodbye party"],
      agenda: { everyMinutes: 20, aims: ["Invite whoever is here to the boat party", "Ask about Sam's big news"] },
    },
  },
};
