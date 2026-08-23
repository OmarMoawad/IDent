import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import { insertConnectedSource, upsertMessage } from "../../comms/store.js";
import { RATE_LIMIT_POLICIES } from "../../rate-limit/policy.js";
import { countRequest } from "../../rate-limit/store.js";
import type { RetrievedReference } from "../assistant-intent.js";
import { DbActionProposalSink } from "./proposal-service.js";
import { createWriteActionService, ActionRateLimitedError } from "./write-action-service.js";
import { ActionConflictError } from "./types.js";
import type { ActionExecutorRegistry, ExecutionResult } from "./executors.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function fakeExecutor(result: ExecutionResult = { status: "succeeded", code: "ok" }): ActionExecutorRegistry & { calls: number } {
  return { calls: 0, async execute() { this.calls += 1; return result; } };
}

async function setup() {
  app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: { username: `svc_${randomUUID().replace(/-/g, "").slice(0, 14)}`, password: "correct horse battery staple", wrappedAmkKey: "wrap" },
  });
  const { identityId } = res.json() as { identityId: string };
  const [session] = await db.select().from(sessions).where(eq(sessions.identityId, identityId));
  const source = await insertConnectedSource({ identityId, provider: "gmail" });
  const message = await upsertMessage({
    identityId, sourceId: source.id, externalId: `ext-${randomUUID()}`, subject: "Hi",
    body: "b", participants: JSON.stringify({ from: [{ address: "jane@example.com" }], to: [] }), occurredAt: new Date(),
  });
  const refs: RetrievedReference[] = [{ ref: "message:1", kind: "message", id: message.id }];
  return { identityId, sessionId: session.id, refs };
}

async function proposeDraft(identityId: string, sessionId: string, refs: RetrievedReference[]) {
  const [preview] = await new DbActionProposalSink().propose({
    identityId, sessionId, refs, intents: [{ type: "reply.draft", targetRef: "message:1", body: "Thanks" }],
  });
  return preview;
}

describe("executeAction effect-limit ordering", () => {
  it("does not consume quota on a replayed execute that lost the claim", async () => {
    const { identityId, sessionId, refs } = await setup();
    const executor = fakeExecutor();
    const service = createWriteActionService(executor);
    const preview = await proposeDraft(identityId, sessionId, refs);

    await service.confirmAction({ identityId, sessionId, actionId: preview.id, payloadDigest: preview.payloadDigest });
    await service.executeAction({ identityId, actionId: preview.id, payloadDigest: preview.payloadDigest });

    // The second execute is stopped at the single-shot claim gate (the action
    // is no longer `approved`) — a conflict, NOT a rate-limit, proving no
    // quota was consumed on the replay.
    await expect(
      service.executeAction({ identityId, actionId: preview.id, payloadDigest: preview.payloadDigest }),
    ).rejects.toBeInstanceOf(ActionConflictError);
    expect(executor.calls).toBe(1);
  });

  it("lands the action terminal (failed/effect_limit) when the ceiling is full after the claim", async () => {
    const { identityId, sessionId, refs } = await setup();
    const service = createWriteActionService(fakeExecutor());
    const preview = await proposeDraft(identityId, sessionId, refs);
    await service.confirmAction({ identityId, sessionId, actionId: preview.id, payloadDigest: preview.payloadDigest });

    // Exhaust this identity's draft-effect ceiling up front.
    const policy = RATE_LIMIT_POLICIES["assistant-action-draft-effect"];
    for (let i = 0; i < policy.limit; i++) await countRequest(policy, `identity:${identityId}`);

    await expect(
      service.executeAction({ identityId, actionId: preview.id, payloadDigest: preview.payloadDigest }),
    ).rejects.toBeInstanceOf(ActionRateLimitedError);

    // Not stranded in `executing`: it is terminal.
    const action = await service.getAction(identityId, preview.id);
    expect(action.status).toBe("failed");
    expect(action.outcomeCode).toBe("effect_limit");
  });
});
