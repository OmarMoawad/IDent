import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assistantActionApprovals,
  assistantActionAuditEvents,
  assistantElevationEvents,
  assistantPendingActions,
} from "../../db/schema.js";
import { digestCanonical } from "./canonical-json.js";
import { ActionConflictError, type PendingActionRow, type PendingActionStatus } from "./types.js";

/**
 * Phase 2 session 5 — the durable, guarded store for write actions.
 *
 * Every state change here is a conditional UPDATE whose WHERE clause names
 * the status it is transitioning *from*, so two concurrent callers cannot
 * both advance the same action — Postgres serialises them on the row and the
 * loser matches zero rows. Each change appends one event to a per-action
 * hash chain, so the audit trail is both append-only (database triggers) and
 * tamper-evident (each hash covers the previous one).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AuditDetail = Record<string, string | number | boolean | null>;

/**
 * Append one event to an action's hash chain, inside a transaction. Reads
 * the current tail to derive the next sequence number and the previous hash;
 * the unique `(action_id, seq)` constraint makes a concurrent double-append
 * fail rather than fork the chain.
 */
async function appendAudit(
  tx: Tx,
  actionId: string,
  eventType: string,
  detail: AuditDetail = {},
): Promise<void> {
  const [last] = await tx
    .select({ seq: assistantActionAuditEvents.seq, hash: assistantActionAuditEvents.hash })
    .from(assistantActionAuditEvents)
    .where(eq(assistantActionAuditEvents.actionId, actionId))
    .orderBy(desc(assistantActionAuditEvents.seq))
    .limit(1);

  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? null;
  const detailJson = JSON.stringify(detail);
  const hash = digestCanonical({ actionId, seq, eventType, detail: detailJson, prevHash });

  await tx.insert(assistantActionAuditEvents).values({
    actionId,
    seq,
    eventType,
    detail: detailJson,
    prevHash,
    hash,
  });
}

export type CreatePendingActionInput = {
  identityId: string;
  requestingSessionId: string;
  actionType: string;
  schemaVersion: number;
  canonicalPayload: string;
  payloadDigest: string;
  retrievalSlice: string;
  preconditions: string;
  operationKey: string;
  expiresAt: Date;
};

/** Persist a new pending action and open its audit chain with a `proposed` event. */
export async function createPendingAction(input: CreatePendingActionInput): Promise<PendingActionRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(assistantPendingActions).values(input).returning();
    await appendAudit(tx, row.id, "proposed", { actionType: input.actionType });
    return row as PendingActionRow;
  });
}

export async function getPendingAction(actionId: string): Promise<PendingActionRow | null> {
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(eq(assistantPendingActions.id, actionId));
  return (row as PendingActionRow) ?? null;
}

export type ActionApprovalInput = {
  actionId: string;
  identityId: string;
  sessionId: string;
  payloadDigest: string;
  now: Date;
};

/**
 * Confirm a pending action. Verifies ownership, the on-screen digest, that
 * it is still `pending`, and that it has not expired — then moves it to
 * `approved`, records an immutable approval row, and audits the approval.
 * A cross-identity caller is reported as `not-found`, never as a different
 * error that would confirm the action exists.
 */
export async function approvePendingAction(input: ActionApprovalInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(assistantPendingActions)
      .where(eq(assistantPendingActions.id, input.actionId));

    if (!current || current.identityId !== input.identityId) {
      throw new ActionConflictError("not-found");
    }
    if (current.payloadDigest !== input.payloadDigest) {
      throw new ActionConflictError("digest-mismatch");
    }
    if (current.status !== "pending") {
      throw new ActionConflictError("wrong-status", `Cannot approve an action that is ${current.status}`);
    }
    if (current.expiresAt.getTime() <= input.now.getTime()) {
      throw new ActionConflictError("expired");
    }

    const updated = await tx
      .update(assistantPendingActions)
      .set({ status: "approved", updatedAt: input.now })
      .where(and(eq(assistantPendingActions.id, input.actionId), eq(assistantPendingActions.status, "pending")))
      .returning({ id: assistantPendingActions.id });

    // Lost a race to another confirmation that advanced it first.
    if (updated.length === 0) throw new ActionConflictError("wrong-status");

    await tx.insert(assistantActionApprovals).values({
      actionId: input.actionId,
      identityId: input.identityId,
      confirmingSessionId: input.sessionId,
      payloadDigest: input.payloadDigest,
    });
    await appendAudit(tx, input.actionId, "approved", { sessionId: input.sessionId });
  });
}

/**
 * Atomically claim an approved action for execution. Exactly one concurrent
 * caller wins — the `WHERE status='approved'` guard serialises them on the
 * row — and the loser gets an `ActionConflictError`. Returns the claimed row
 * so the executor has the canonical payload and preconditions.
 */
export async function claimExecution(actionId: string, now: Date = new Date()): Promise<PendingActionRow> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(assistantPendingActions)
      .set({ status: "executing", updatedAt: now })
      .where(and(eq(assistantPendingActions.id, actionId), eq(assistantPendingActions.status, "approved")))
      .returning();

    if (claimed.length === 0) throw new ActionConflictError("wrong-status", "Action is not approved for execution");

    await appendAudit(tx, actionId, "execution-claimed", {});
    return claimed[0] as PendingActionRow;
  });
}

/** Record the terminal-ish outcome of an executing action and audit it. */
export async function recordActionOutcome(
  actionId: string,
  status: Extract<PendingActionStatus, "succeeded" | "failed" | "outcome_unknown">,
  outcomeCode: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(assistantPendingActions)
      .set({ status, outcomeCode, updatedAt: now })
      .where(and(eq(assistantPendingActions.id, actionId), eq(assistantPendingActions.status, "executing")))
      .returning({ id: assistantPendingActions.id });

    if (updated.length === 0) throw new ActionConflictError("wrong-status", "Action is not executing");

    await appendAudit(tx, actionId, "outcome", { status, outcomeCode });
  });
}

/** Cancel a pending or approved action. Terminal states are left untouched. */
export async function cancelPendingAction(
  actionId: string,
  identityId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(assistantPendingActions)
      .where(eq(assistantPendingActions.id, actionId));

    if (!current || current.identityId !== identityId) throw new ActionConflictError("not-found");
    if (current.status !== "pending" && current.status !== "approved") {
      throw new ActionConflictError("wrong-status", `Cannot cancel an action that is ${current.status}`);
    }

    await tx
      .update(assistantPendingActions)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(assistantPendingActions.id, actionId));
    await appendAudit(tx, actionId, "cancelled", {});
  });
}

/**
 * Consume a single-use elevation for an action. The unique
 * `consumed_by_action_id` makes a second consumption of the same elevation
 * impossible; an already-consumed or expired elevation is rejected.
 */
export async function consumeActionElevation(
  elevationId: string,
  actionId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(assistantElevationEvents)
      .set({ consumedAt: now, consumedByActionId: actionId })
      .where(
        and(
          eq(assistantElevationEvents.id, elevationId),
          isNull(assistantElevationEvents.consumedByActionId),
          gt(assistantElevationEvents.expiresAt, now),
        ),
      )
      .returning({ id: assistantElevationEvents.id });

    if (claimed.length === 0) throw new ActionConflictError("already-consumed", "Elevation is unavailable");
    await appendAudit(tx, actionId, "elevation-consumed", { elevationId });
  });
}

/**
 * Recompute an action's audit hash chain and check it is intact: sequential,
 * each event's `prevHash` equal to the prior event's `hash`, and every hash
 * equal to a fresh digest of its contents. Any tampering — a removed event,
 * an altered detail — breaks this.
 */
export async function auditChainIsValid(actionId: string): Promise<boolean> {
  const events = await db
    .select()
    .from(assistantActionAuditEvents)
    .where(eq(assistantActionAuditEvents.actionId, actionId))
    .orderBy(asc(assistantActionAuditEvents.seq));

  let prevHash: string | null = null;
  let expectedSeq = 1;
  for (const event of events) {
    if (event.seq !== expectedSeq) return false;
    if (event.prevHash !== prevHash) return false;
    const recomputed = digestCanonical({
      actionId,
      seq: event.seq,
      eventType: event.eventType,
      detail: event.detail,
      prevHash: event.prevHash,
    });
    if (recomputed !== event.hash) return false;
    prevHash = event.hash;
    expectedSeq += 1;
  }
  return events.length > 0;
}
