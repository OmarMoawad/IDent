/**
 * Phase 2 session 5. The one narrow doorway a model's output may come
 * through, and nothing wider.
 *
 * The security property this file holds: model output can *propose* a
 * constrained intent, but it can never name a recipient, a provider id, an
 * identity, or any field the server owns. An intent references a target
 * only by an opaque `message:<n>` / `event:<n>` handle that the server later
 * resolves against the exact retrieval slice it built for that request — so
 * a fabricated or out-of-slice reference resolves to nothing. Anything the
 * parser does not recognise, or any extra field smuggled alongside a valid
 * one, is rejected here rather than being quietly dropped, because a
 * silently-ignored field is how an injected `providerId` or `to` would slip
 * past unnoticed.
 */

export type ActionIntent =
  | { type: "reply.draft"; targetRef: `message:${number}`; body: string }
  | { type: "message.archive"; targetRefs: Array<`message:${number}`> }
  | { type: "calendar.event.accept"; targetRef: `event:${number}` };

/**
 * An opaque reference the retrieval step emitted, paired with the exact
 * identity-owned record it stands for. The model sees only `ref`; the
 * server keeps the `id` and resolves against it.
 */
export type RetrievedReference = { ref: string; kind: "message" | "event"; id: string };

/** The most archive targets a single action may carry (spec: batch ≤ 10). */
export const MAX_ARCHIVE_TARGETS = 10;

export class InvalidActionIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidActionIntentError";
  }
}

const MESSAGE_REF = /^message:\d+$/;
const EVENT_REF = /^event:\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject any key not in the allow-list, so an injected field cannot ride along. */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidActionIntentError(`Unexpected field "${key}" in action intent`);
    }
  }
}

function requireMessageRef(value: unknown): `message:${number}` {
  if (typeof value !== "string" || !MESSAGE_REF.test(value)) {
    throw new InvalidActionIntentError(`Expected a message:<n> reference, got ${JSON.stringify(value)}`);
  }
  return value as `message:${number}`;
}

function requireEventRef(value: unknown): `event:${number}` {
  if (typeof value !== "string" || !EVENT_REF.test(value)) {
    throw new InvalidActionIntentError(`Expected an event:<n> reference, got ${JSON.stringify(value)}`);
  }
  return value as `event:${number}`;
}

function parseOne(value: unknown): ActionIntent {
  if (!isRecord(value)) {
    throw new InvalidActionIntentError("Each action intent must be an object");
  }

  switch (value.type) {
    case "reply.draft": {
      rejectUnknownKeys(value, ["type", "targetRef", "body"]);
      if (typeof value.body !== "string" || value.body.trim().length === 0) {
        throw new InvalidActionIntentError("reply.draft needs a non-empty body");
      }
      return { type: "reply.draft", targetRef: requireMessageRef(value.targetRef), body: value.body };
    }
    case "message.archive": {
      rejectUnknownKeys(value, ["type", "targetRefs"]);
      if (!Array.isArray(value.targetRefs) || value.targetRefs.length === 0) {
        throw new InvalidActionIntentError("message.archive needs at least one target");
      }
      if (value.targetRefs.length > MAX_ARCHIVE_TARGETS) {
        throw new InvalidActionIntentError(
          `message.archive accepts at most ${MAX_ARCHIVE_TARGETS} targets, got ${value.targetRefs.length}`,
        );
      }
      return { type: "message.archive", targetRefs: value.targetRefs.map(requireMessageRef) };
    }
    case "calendar.event.accept": {
      rejectUnknownKeys(value, ["type", "targetRef"]);
      return { type: "calendar.event.accept", targetRef: requireEventRef(value.targetRef) };
    }
    default:
      throw new InvalidActionIntentError(`Unsupported action type ${JSON.stringify(value.type)}`);
  }
}

/**
 * Parse a model's proposed action intents, strictly.
 *
 * Returns `[]` for `null`/`undefined`/`[]` — an answer-only response is the
 * common, expected case and not an error. Anything that is present but not a
 * clean array of exactly-shaped intents throws, because a malformed intent
 * is not something to guess at: it is either a model mistake or an injection
 * attempt, and both should stop here rather than reaching the proposal step.
 */
export function parseActionIntents(value: unknown): ActionIntent[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new InvalidActionIntentError("Action intents must be an array");
  }
  return value.map(parseOne);
}
