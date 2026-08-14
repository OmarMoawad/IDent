import { MAX_QUESTION_LENGTH } from "./assistant-config.js";
import { buildAssistantContext } from "./assistant-retrieval.js";
import { AssistantUnavailableError, type AssistantClient } from "./assistant-client.js";

export type AssistantResult = {
  answer: string;
  refused: boolean;
  /** What was sent to the provider, so the UI can be honest about it. */
  contextSent: { messages: number; events: number; contacts: number; reminders: number };
};

export class QuestionTooLongError extends Error {
  constructor() {
    super(`Question must be ${MAX_QUESTION_LENGTH} characters or fewer.`);
    this.name = "QuestionTooLongError";
  }
}

/**
 * Answers one question about a single identity's own data.
 *
 * Read-only by construction: this function retrieves and formats, then
 * calls the model. There is no path from a model response back into the
 * database — the assistant cannot send, edit, or delete anything, because
 * nothing here would carry out such an instruction if it produced one.
 */
export async function askAssistant(
  identityId: string,
  question: string,
  client: AssistantClient | null,
): Promise<AssistantResult> {
  const trimmed = question.trim();
  if (!trimmed) throw new QuestionTooLongError();
  if (trimmed.length > MAX_QUESTION_LENGTH) throw new QuestionTooLongError();
  if (!client) throw new AssistantUnavailableError();

  // Context is always built from *this* identity's data — the identityId
  // comes from the validated session, never from the question.
  const context = await buildAssistantContext(identityId, trimmed);
  const answer = await client.ask({ question: trimmed, context: context.text });

  return { answer: answer.text, refused: answer.refused, contextSent: context.counts };
}
