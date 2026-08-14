import type { AssistantAnswer, AssistantClient } from "../assistant-client.js";

/**
 * Records exactly what would have been sent to Anthropic, so tests can
 * assert on the privacy boundary — that the payload contains what it
 * should and, more importantly, that it does not contain what it
 * shouldn't.
 */
export class FakeAssistantClient implements AssistantClient {
  public calls: Array<{ question: string; context: string }> = [];

  constructor(private readonly answer: Partial<AssistantAnswer> = {}) {}

  async ask(input: { question: string; context: string }): Promise<AssistantAnswer> {
    this.calls.push(input);
    return {
      text: this.answer.text ?? "A fake answer.",
      refused: this.answer.refused ?? false,
      usage: this.answer.usage ?? { inputTokens: 10, outputTokens: 5 },
    };
  }

  get lastContext(): string {
    return this.calls[this.calls.length - 1]?.context ?? "";
  }
}
