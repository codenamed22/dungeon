import { OpenRouterChat } from "../src/agents/openrouter.ts";
import type { ChatSettings, OpenRouterModel } from "../src/agents/openrouter.ts";

// A simulated OpenRouter: each request goes to a handler, which returns the completion or waits to be cancelled.
export type Handler = (body: Record<string, any>, signal: AbortSignal) => Promise<unknown>;

export function simulatedOpenRouter(handler: () => Handler): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const reply = await handler()(JSON.parse(String(init.body)), init.signal!);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

/** Waits until the request is cancelled, then fails as fetch does. */
export const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
});

export const toolCall = (id: string, name: string, args: unknown) => ({
  id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

export function completion(message: Record<string, unknown>, usage: Record<string, number> = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.002 }) {
  return {
    model: "test/creator",
    choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }],
    usage,
  };
}

export const catalog: OpenRouterModel[] = [
  { id: "test/creator", name: "Creator", supported_parameters: ["tools", "max_tokens", "reasoning"], reasoning: { supported_efforts: ["low", "high"] } },
  { id: "test/plain", name: "Plain", supported_parameters: ["max_tokens", "response_format"] },
];

export function chatWith(handler: Handler, settings: Partial<ChatSettings> = {}): OpenRouterChat {
  return OpenRouterChat.create({
    apiKey: "test-key", model: "test/creator", effort: undefined, maxOutputTokens: 16_000, maxRetries: 0,
    sleep: async () => {}, fetch: simulatedOpenRouter(() => handler), ...settings,
  }, catalog);
}

