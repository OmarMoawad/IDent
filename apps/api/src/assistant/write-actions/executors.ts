import type {
  MailWriteClient,
  WriteOutcome,
} from "../../comms/google-mail-write-client.js";
import type { CalendarWriteClient } from "../../comms/google-calendar-write-client.js";
import type { PendingActionRow } from "./types.js";

/**
 * Phase 2 session 5 — the executor: the *only* place an approved action
 * reaches a provider write.
 *
 * It is reached only after a human-confirmed, atomically-claimed action, and
 * it is injected into the routes rather than imported by any model-facing
 * module (see the import-boundary test). It parses the server-owned
 * canonical payload, obtains a write token through a provider that re-checks
 * ownership and scope immediately before mutation, dispatches to the narrow
 * adapter, and returns a safe outcome — never a raw provider response.
 */

export type ExecutionResult = {
  status: "succeeded" | "failed" | "outcome_unknown";
  code: string;
};

export type WriteCapability = "gmail.modify" | "calendar.events";

/**
 * Resolves an access token for one identity's source, re-checking ownership,
 * a live connection, and that the required write scope was actually granted.
 * The real implementation is connection-service backed (and needs a real
 * Google grant); tests inject a fake.
 */
export interface WriteTokenProvider {
  tokenFor(input: {
    identityId: string;
    sourceId: string;
    capability: WriteCapability;
  }): Promise<{ accessToken: string } | { ineligible: string }>;
}

export interface ActionExecutorRegistry {
  execute(action: PendingActionRow): Promise<ExecutionResult>;
}

type ReplyPayload = { sourceId: string; providerMessageId: string; to: string; subject: string; body: string };
type ArchivePayload = { targets: { sourceId: string; providerMessageId: string }[] };
type AcceptPayload = { sourceId: string; providerEventId: string };

export class DefaultActionExecutorRegistry implements ActionExecutorRegistry {
  constructor(
    private readonly tokens: WriteTokenProvider,
    private readonly mail: MailWriteClient,
    private readonly calendar: CalendarWriteClient,
  ) {}

  async execute(action: PendingActionRow): Promise<ExecutionResult> {
    const payload = JSON.parse(action.canonicalPayload) as Record<string, unknown>;

    if (action.actionType === "reply.draft") {
      const p = payload as unknown as ReplyPayload;
      const token = await this.token(action.identityId, p.sourceId, "gmail.modify");
      if ("ineligible" in token) return { status: "failed", code: `ineligible:${token.ineligible}` };
      return toResult(
        await this.mail.createReplyDraft(token.accessToken, {
          to: p.to,
          subject: p.subject,
          body: p.body,
          operationKey: action.operationKey,
        }),
      );
    }

    if (action.actionType === "message.archive") {
      const p = payload as unknown as ArchivePayload;
      // Every target shares one connection in v1 (the slice is one identity's
      // mail), so one token covers the batch.
      const sourceId = p.targets[0]?.sourceId;
      const token = await this.token(action.identityId, sourceId, "gmail.modify");
      if ("ineligible" in token) return { status: "failed", code: `ineligible:${token.ineligible}` };

      const outcomes: WriteOutcome[] = [];
      for (const target of p.targets) {
        outcomes.push(await this.mail.archiveMessage(token.accessToken, target.providerMessageId));
      }
      return aggregate(outcomes);
    }

    // calendar.event.accept
    const p = payload as unknown as AcceptPayload;
    const token = await this.token(action.identityId, p.sourceId, "calendar.events");
    if ("ineligible" in token) return { status: "failed", code: `ineligible:${token.ineligible}` };
    return toResult(
      await this.calendar.acceptInvitation(token.accessToken, { providerEventId: p.providerEventId }),
    );
  }

  private token(identityId: string, sourceId: string | undefined, capability: WriteCapability) {
    if (!sourceId) return Promise.resolve({ ineligible: "no_source" } as const);
    return this.tokens.tokenFor({ identityId, sourceId, capability });
  }
}

function toResult(outcome: WriteOutcome): ExecutionResult {
  if (outcome.status === "succeeded") {
    return { status: "succeeded", code: outcome.duplicate ? "duplicate" : "ok" };
  }
  return { status: outcome.status, code: outcome.code };
}

/**
 * Combine per-target outcomes for a batch archive. Any unresolved outcome
 * makes the batch `outcome_unknown` (never retried blindly); any definite
 * failure makes it `failed`; only an all-success batch succeeds.
 */
function aggregate(outcomes: WriteOutcome[]): ExecutionResult {
  if (outcomes.some((o) => o.status === "outcome_unknown")) {
    return { status: "outcome_unknown", code: "partial_unknown" };
  }
  const failure = outcomes.find((o) => o.status === "failed");
  if (failure && failure.status === "failed") return { status: "failed", code: failure.code };
  // Every target already archived — a wholly idempotent batch.
  const allDuplicate = outcomes.length > 0 && outcomes.every((o) => o.status === "succeeded" && o.duplicate);
  return { status: "succeeded", code: allDuplicate ? "duplicate" : "ok" };
}
