import type {
  AdventureInfo, AgentPrompts, ChatEntry, CreatorEvent, Draft, DraftSummary, DraftView, EventView, MemoryReport, MetricsReport,
  ModelInfo, RunStatus, Setup, TraceRecord, WorldSummary, WorldView,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Who is signed in. `login` is false when the director runs without Google sign-in. */
export interface SessionInfo {
  login: boolean;
  email: string | null;
  allowed: boolean;
}

/** Sent on the window when the server says this browser is no longer signed in, so the app shows its sign-in screen. */
export const SIGNED_OUT_EVENT = "dungeons:signed-out";

function refused(status: number, message: string, code: string | undefined): ApiError {
  if ((status === 401 && code === "SIGN_IN") || (status === 403 && code === "NOT_ALLOWED")) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  return new ApiError(status, message, code);
}

/** An Auth.js action, done the way next-auth/react does it: a CSRF token, a form post, then wherever it leads. */
async function authAction(action: string, callbackUrl: string): Promise<void> {
  const { csrfToken } = await (await fetch("/api/auth/csrf")).json() as { csrfToken: string };
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    body: new URLSearchParams({ csrfToken, callbackUrl }),
  });
  const { url } = await response.json() as { url?: string };
  window.location.assign(url ?? callbackUrl);
}

/** Goes to Google and comes back to `callbackUrl`; `chooseAccount` makes Google ask which account to use. */
export function signIn(callbackUrl: string, chooseAccount = false): Promise<void> {
  return authAction(`signin/google${chooseAccount ? "?prompt=select_account" : ""}`, callbackUrl);
}

export function signOut(): Promise<void> {
  return authAction("signout", "/");
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (data ?? {}) as { error?: string; code?: string };
    throw refused(response.status, problem.error ?? response.statusText, problem.code);
  }
  return data as T;
}

const at = (worldId: string) => `/worlds/${encodeURIComponent(worldId)}`;
const draftAt = (draftId: string) => `/drafts/${encodeURIComponent(draftId)}`;

/** What the AI creator's stream sends, line by line. */
export type AssistantEvent =
  | CreatorEvent
  | { type: "start"; model: string }
  | { type: "heartbeat" }
  | { type: "done"; entry: ChatEntry; draft: DraftView }
  | { type: "error"; message: string };

export interface IntroduceInput {
  text: string;
  locationIds?: string[];
  lockRoutes?: { fromId: string; destinationId: string }[];
  unlockRoutes?: { fromId: string; destinationId: string }[];
}

export interface RunInput {
  turns: number;
  maxModelCalls?: number;
  maxCost?: number;
}

export const api = {
  session: () => request<SessionInfo>("GET", "/session"),
  adventures: () => request<AdventureInfo[]>("GET", "/adventures"),
  worlds: () => request<{ worlds: WorldSummary[]; keyConfigured: boolean }>("GET", "/worlds"),
  createWorld: (body: { id: string; name?: string; adventureId?: string; seed?: unknown }) => request<WorldView>("POST", "/worlds", body),
  world: (worldId: string) => request<WorldView>("GET", at(worldId)),
  /** Every event after `after`, page by page. */
  async events(worldId: string, after = 0): Promise<EventView[]> {
    const all: EventView[] = [];
    for (;;) {
      const page = await request<EventView[]>("GET", `${at(worldId)}/events?after=${after}&limit=1000`);
      all.push(...page);
      if (page.length < 1000) return all;
      after = page.at(-1)!.sequence;
    }
  },
  agent: (worldId: string, characterId: string) => request<AgentPrompts>("GET", `${at(worldId)}/agents/${encodeURIComponent(characterId)}`),
  memory: (worldId: string, characterId: string, search?: string) => request<MemoryReport>(
    "GET",
    `${at(worldId)}/memory/${encodeURIComponent(characterId)}${search ? `?search=${encodeURIComponent(search)}` : ""}`,
  ),
  traces: (worldId: string, last = 50) => request<TraceRecord[]>("GET", `${at(worldId)}/traces?last=${last}`),
  report: (worldId: string) => request<MetricsReport>("GET", `${at(worldId)}/report`),
  models: (query: string) => request<ModelInfo[]>("GET", `/models?q=${encodeURIComponent(query)}`),
  saveSetup: (worldId: string, setup: Setup) => request<WorldView>("PUT", `${at(worldId)}/setup`, setup),
  mute: (worldId: string, characterIds: string[], muted: boolean) => request<WorldView>("POST", `${at(worldId)}/mute`, { characterIds, muted }),
  steer: (worldId: string, text: string, targetId?: string) => request<{ sequence: number }>(
    "POST", `${at(worldId)}/steer`, { text, ...(targetId ? { targetId } : {}) },
  ),
  introduce: (worldId: string, input: IntroduceInput) => request<{ sequence: number }>("POST", `${at(worldId)}/introduce`, input),
  retcon: (worldId: string, sequence: number, text: string) => request<{ sequence: number }>("POST", `${at(worldId)}/retcon`, { sequence, text }),
  branch: (worldId: string, through: number, id: string, name?: string) => request<WorldView>(
    "POST", `${at(worldId)}/branch`, { through, id, ...(name ? { name } : {}) },
  ),
  step: (worldId: string, actorId?: string) => request<RunStatus>("POST", `${at(worldId)}/step`, actorId ? { actorId } : {}),
  run: (worldId: string, input: RunInput) => request<RunStatus>("POST", `${at(worldId)}/run`, input),
  rehearse: (worldId: string) => request<RunStatus>("POST", `${at(worldId)}/rehearse`, {}),
  pause: (worldId: string) => request<RunStatus | null>("POST", `${at(worldId)}/pause`, {}),
  prompts: (worldId: string) => request<{ narrator: string; referee: string; judge?: string }>("GET", `${at(worldId)}/prompts`),

  creator: () => request<{ model: string; keyConfigured: boolean }>("GET", "/creator"),
  drafts: () => request<{ drafts: DraftSummary[] }>("GET", "/drafts"),
  createDraft: (body: { adventureId?: string; name?: string }) => request<DraftView>("POST", "/drafts", body),
  draft: (draftId: string) => request<DraftView>("GET", draftAt(draftId)),
  saveDraft: (draftId: string, draft: Draft, expectedRevision: number) => request<DraftView>("PUT", draftAt(draftId), { draft, expectedRevision }),
  deleteDraft: (draftId: string) => request<{ ok: true }>("DELETE", draftAt(draftId), {}),
  publishDraft: (draftId: string, worldId: string, expectedRevision: number) => request<DraftView>(
    "POST", `${draftAt(draftId)}/publish`, { worldId, expectedRevision },
  ),

  /**
   * Sends a message to the AI creator and reports its events as they arrive.
   * Refusals before it starts throw an ApiError; later failures arrive as an
   * error event. Aborting the signal stops it, keeping what it has done.
   */
  async assist(draftId: string, body: { message: string; model?: string; expectedRevision: number }, onEvent: (event: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(`/api${draftAt(draftId)}/assistant`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    if (!response.ok || !response.body) {
      const problem = ((await response.json().catch(() => null)) ?? {}) as { error?: string; code?: string };
      throw refused(response.status, problem.error ?? response.statusText, problem.code);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) onEvent(JSON.parse(line) as AssistantEvent);
      }
    }
  },
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
