import { MAX_QUESTION_LENGTH } from "./assistant-config.js";
import { buildAssistantContext } from "./assistant-retrieval.js";
import { AssistantUnavailableError, type AssistantClient } from "./assistant-client.js";
import type { ActionProposalSink, PendingActionPreview } from "./write-actions/proposal-service.js";

export type AssistantResult = {
  answer: string;
  refused: boolean;
  /** What was sent to the provider, so the UI can be honest about it. */
  contextSent: { messages: number; events: number; contacts: number; reminders: number };
  /**
   * Server-built pending actions the model proposed — empty unless a
   * proposal sink is supplied *and* the model returned a structured intent.
   * Each is a proposal awaiting human confirmation, never an executed write.
   */
  pendingActions: PendingActionPreview[];
};

/**
 * Write-action capabilities, passed in explicitly. `proposalSink` turns a
 * model intent into a server-owned pending action. `executorRegistry` is
 * accepted only to make the boundary provable: `askAssistant` never calls
 * it, so a model response can reach a proposal at most — never execution.
 * The import-boundary test forbids this module from importing an executor.
 */
export type AssistantWriteDeps = {
  sessionId?: string;
  proposalSink?: ActionProposalSink;
  executorRegistry?: { execute: (...args: unknown[]) => unknown };
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
  deps: AssistantWriteDeps = {},
): Promise<AssistantResult> {
  const trimmed = question.trim();
  if (!trimmed) throw new QuestionTooLongError();
  if (trimmed.length > MAX_QUESTION_LENGTH) throw new QuestionTooLongError();
  if (!client) throw new AssistantUnavailableError();

  // Context is always built from *this* identity's data — the identityId
  // comes from the validated session, never from the question.
  const context = await buildAssistantContext(identityId, trimmed);
  const answer = await client.ask({ question: trimmed, context: context.text });

  // A structured intent becomes a *proposal* — a pending action bound to a
  // server-built payload and the slice it was resolved against — and never
  // anything more from here. The executor is deliberately not consulted;
  // execution is a separate, human-confirmed transition.
  let pendingActions: PendingActionPreview[] = [];
  if (deps.proposalSink && deps.sessionId && answer.actionIntents.length > 0) {
    pendingActions = await deps.proposalSink.propose({
      identityId,
      sessionId: deps.sessionId,
      refs: context.refs,
      intents: answer.actionIntents,
    });
  }

  return { answer: answer.text, refused: answer.refused, contextSent: context.counts, pendingActions };
}
