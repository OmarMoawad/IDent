/**
 * Phase 2 session 5 — shared types for the write-action subsystem.
 */

export type WriteActionType = "reply.draft" | "message.archive" | "calendar.event.accept";

export type PendingActionStatus =
  | "pending"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "expired"
  | "cancelled";

/** Terminal states an action can never leave. */
export const TERMINAL_STATUSES: PendingActionStatus[] = [
  "succeeded",
  "failed",
  "outcome_unknown",
  "expired",
  "cancelled",
];

export const ACTION_SCHEMA_VERSION = 1;

/** How long after proposal an unapproved/unexecuted action stays actionable. */
export const ACTION_TTL_MS = 10 * 60 * 1000;

export type PendingActionRow = {
  id: string;
  identityId: string;
  requestingSessionId: string;
  actionType: string;
  schemaVersion: number;
  canonicalPayload: string;
  payloadDigest: string;
  retrievalSlice: string;
  preconditions: string;
  status: PendingActionStatus;
  operationKey: string;
  outcomeCode: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A guarded transition could not proceed: the action was in the wrong state,
 * expired, owned by another identity, or the confirmed digest did not match.
 * Routes turn this into a 404 (cross-identity) or 409 (stale/conflict) — a
 * raw database constraint error never escapes to a handler.
 */
export class ActionConflictError extends Error {
  constructor(
    public readonly reason:
      | "not-found"
      | "wrong-status"
      | "expired"
      | "digest-mismatch"
      | "identity-mismatch"
      | "already-consumed",
    message?: string,
  ) {
    super(message ?? `Action transition rejected: ${reason}`);
    this.name = "ActionConflictError";
  }
}
