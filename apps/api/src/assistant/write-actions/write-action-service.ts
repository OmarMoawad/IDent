import { RATE_LIMIT_POLICIES } from "../../rate-limit/policy.js";
import { countRequest } from "../../rate-limit/store.js";
import type { ActionExecutorRegistry } from "./executors.js";
import {
  approvePendingAction,
  cancelPendingAction,
  claimExecution,
  getPendingAction,
  recordActionOutcome,
} from "./store.js";
import { ActionConflictError, type PendingActionRow } from "./types.js";

/**
 * Phase 2 session 5 — the action service: every limit and every state
 * transition for write actions lives here, not in the UI and not only in
 * the Fastify fallback policy. The routes are thin authenticated wrappers
 * over these functions.
 *
 * Two kinds of control, kept distinct on purpose:
 *
 * - **Attempt limits** bound request abuse: a per-session limit (applied by
 *   the Fastify hook on the route) and a per-identity limit (here).
 * - **Effect ceilings** bound real-world consequences per identity per
 *   rolling hour, and are consumed *when execution is claimed* — including
 *   when the provider then fails, so a run of failing calls cannot buy extra
 *   provider attempts.
 */

export class ActionRateLimitedError extends Error {
  constructor(
    public readonly scope: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Rate limit reached: ${scope}`);
    this.name = "ActionRateLimitedError";
  }
}

async function enforceIdentityAttempt(identityId: string): Promise<void> {
  const verdict = await countRequest(
    RATE_LIMIT_POLICIES["assistant-action-attempt-identity"],
    `identity:${identityId}`,
  );
  if (!verdict.allowed) throw new ActionRateLimitedError("identity-attempt", verdict.retryAfterSeconds);
}

/** Consume one effect against the right per-identity ceiling; refuse when full. */
async function consumeEffect(identityId: string, policyName: string): Promise<void> {
  const verdict = await countRequest(RATE_LIMIT_POLICIES[policyName], `identity:${identityId}`);
  if (!verdict.allowed) throw new ActionRateLimitedError(policyName, verdict.retryAfterSeconds);
}

function effectPolicyFor(action: PendingActionRow): { policy: string; count: number } {
  if (action.actionType === "reply.draft") return { policy: "assistant-action-draft-effect", count: 1 };
  if (action.actionType === "calendar.event.accept") return { policy: "assistant-action-calendar-effect", count: 1 };
  const payload = JSON.parse(action.canonicalPayload) as { targets?: unknown[] };
  return { policy: "assistant-action-archive-effect", count: payload.targets?.length ?? 1 };
}

function requireOwned(action: PendingActionRow | null, identityId: string): PendingActionRow {
  // A cross-identity action is indistinguishable from a missing one.
  if (!action || action.identityId !== identityId) throw new ActionConflictError("not-found");
  return action;
}

export type WriteActionService = ReturnType<typeof createWriteActionService>;

export function createWriteActionService(executor: ActionExecutorRegistry) {
  return {
    async getAction(identityId: string, actionId: string): Promise<PendingActionRow> {
      return requireOwned(await getPendingAction(actionId), identityId);
    },

    async confirmAction(input: {
      identityId: string;
      sessionId: string;
      actionId: string;
      payloadDigest: string;
    }): Promise<PendingActionRow> {
      await enforceIdentityAttempt(input.identityId);
      await approvePendingAction({
        actionId: input.actionId,
        identityId: input.identityId,
        sessionId: input.sessionId,
        payloadDigest: input.payloadDigest,
        now: new Date(),
      });
      return requireOwned(await getPendingAction(input.actionId), input.identityId);
    },

    async cancelAction(identityId: string, actionId: string): Promise<PendingActionRow> {
      await enforceIdentityAttempt(identityId);
      await cancelPendingAction(actionId, identityId);
      return requireOwned(await getPendingAction(actionId), identityId);
    },

    async executeAction(input: {
      identityId: string;
      actionId: string;
      payloadDigest: string;
    }): Promise<PendingActionRow> {
      await enforceIdentityAttempt(input.identityId);

      const action = requireOwned(await getPendingAction(input.actionId), input.identityId);
      if (action.payloadDigest !== input.payloadDigest) throw new ActionConflictError("digest-mismatch");
      if (action.status !== "approved") {
        throw new ActionConflictError("wrong-status", `Cannot execute an action that is ${action.status}`);
      }

      // Consume the effect ceiling *before* claiming, so a provider failure
      // after the claim still counts against the hourly budget.
      const { policy, count } = effectPolicyFor(action);
      for (let i = 0; i < count; i++) await consumeEffect(input.identityId, policy);

      // Single-shot claim: concurrent/replayed executes resolve to one.
      const claimed = await claimExecution(action.id);
      const result = await executor.execute(claimed);
      await recordActionOutcome(action.id, result.status, result.code);

      return requireOwned(await getPendingAction(action.id), input.identityId);
    },
  };
}
