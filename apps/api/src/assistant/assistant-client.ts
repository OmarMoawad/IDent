import { resolveAssistantProvider, type AssistantProvider } from "./assistant-config.js";

/**
 * The provider boundary. Everything above this line — retrieval, the
 * privacy bounds, the disclosure — is provider-neutral, which is what lets
 * the backend be a configuration choice rather than a rewrite.
 */
export type AssistantAnswer = {
  text: string;
  /** True when the model declined rather than answered. */
  refused: boolean;
  usage: { inputTokens: number; outputTokens: number };
};

export interface AssistantClient {
  ask(input: { question: string; context: string }): Promise<AssistantAnswer>;
}

export class AssistantUnavailableError extends Error {
  constructor(message = "The assistant is not configured.") {
    super(message);
    this.name = "AssistantUnavailableError";
  }
}

/**
 * Builds the client the environment asks for, or null when nothing is
 * configured. Never falls back to a default that would ship data
 * somewhere the operator did not choose — unavailable is the safe state.
 *
 * The dynamic imports keep each provider's dependencies out of the other's
 * path: a deployment running purely local never loads the Anthropic SDK.
 */
export async function createConfiguredAssistantClient(
  provider: AssistantProvider | null = resolveAssistantProvider(),
): Promise<AssistantClient | null> {
  if (!provider) return null;

  if (provider.id === "openai_compatible") {
    const { OpenAICompatibleClient } = await import("./openai-compatible-client.js");
    return new OpenAICompatibleClient(provider);
  }

  const { AnthropicAssistantClient } = await import("./claude-client.js");
  return new AnthropicAssistantClient(provider);
}
