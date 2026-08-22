import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import {
  assistantActionApprovals,
  assistantActionAuditEvents,
  assistantPendingActions,
  sessions,
} from "../../db/schema.js";
import { digestCanonical } from "./canonical-json.js";
import {
  approvePendingAction,
  auditChainIsValid,
  cancelPendingAction,
  claimExecution,
  createPendingAction,
  recordActionOutcome,
} from "./store.js";
import { ACTION_SCHEMA_VERSION, ActionConflictError } from "./types.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function identityWithSession() {
  app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `u_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  const { identityId } = response.json() as { identityId: string };
  const [session] = await db.select().from(sessions).where(eq(sessions.identityId, identityId));
  return { identityId, sessionId: session.id };
}

async function pendingActionFor(identityId: string, sessionId: string) {
  const payload = { type: "message.archive", targets: ["m1"], schemaVersion: ACTION_SCHEMA_VERSION };
  const canonicalPayload = JSON.stringify(payload);
  return createPendingAction({
    identityId,
    requestingSessionId: sessionId,
    actionType: "message.archive",
    schemaVersion: ACTION_SCHEMA_VERSION,
    canonicalPayload,
    payloadDigest: digestCanonical(payload),
    retrievalSlice: JSON.stringify([{ ref: "message:1", kind: "message", id: "m1" }]),
    preconditions: JSON.stringify({ labels: ["INBOX"] }),
    operationKey: randomUUID(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
}

describe("write-action store transitions", () => {
  it("opens an audit chain on creation and keeps it valid through transitions", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);

    await approvePendingAction({
      actionId: action.id,
      identityId,
      sessionId,
      payloadDigest: action.payloadDigest,
      now: new Date(),
    });
    await claimExecution(action.id);
    await recordActionOutcome(action.id, "succeeded", "ok");

    expect(await auditChainIsValid(action.id)).toBe(true);
  });

  it("lets exactly one of two concurrent execution claims win", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);
    await approvePendingAction({
      actionId: action.id,
      identityId,
      sessionId,
      payloadDigest: action.payloadDigest,
      now: new Date(),
    });

    const [a, b] = await Promise.allSettled([claimExecution(action.id), claimExecution(action.id)]);
    expect([a, b].filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect([a, b].filter((x) => x.status === "rejected")).toHaveLength(1);
  });

  it("rejects a stale digest and a cross-identity confirmation", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const stranger = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);

    await expect(
      approvePendingAction({ actionId: action.id, identityId, sessionId, payloadDigest: "stale", now: new Date() }),
    ).rejects.toMatchObject({ reason: "digest-mismatch" });

    await expect(
      approvePendingAction({
        actionId: action.id,
        identityId: stranger.identityId,
        sessionId: stranger.sessionId,
        payloadDigest: action.payloadDigest,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses to approve an expired action", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const payload = { type: "message.archive", targets: ["m1"] };
    const action = await createPendingAction({
      identityId,
      requestingSessionId: sessionId,
      actionType: "message.archive",
      schemaVersion: ACTION_SCHEMA_VERSION,
      canonicalPayload: JSON.stringify(payload),
      payloadDigest: digestCanonical(payload),
      retrievalSlice: "[]",
      preconditions: "{}",
      operationKey: randomUUID(),
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      approvePendingAction({
        actionId: action.id,
        identityId,
        sessionId,
        payloadDigest: action.payloadDigest,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("cancels a pending action and refuses to cancel a terminal one", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);

    await cancelPendingAction(action.id, identityId);
    await expect(cancelPendingAction(action.id, identityId)).rejects.toBeInstanceOf(ActionConflictError);
  });
});

describe("database-enforced immutability and append-only", () => {
  // Drizzle wraps the driver error; the Postgres RAISE message is on `.cause`.
  const causeMessage = (error: unknown): string => {
    const wrapped = error as { message?: string; cause?: { message?: string } };
    return `${wrapped?.message ?? ""} ${wrapped?.cause?.message ?? ""}`;
  };

  it("rejects an UPDATE to an approval row", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);
    await approvePendingAction({
      actionId: action.id,
      identityId,
      sessionId,
      payloadDigest: action.payloadDigest,
      now: new Date(),
    });

    const error = await db
      .update(assistantActionApprovals)
      .set({ payloadDigest: "tampered" })
      .where(eq(assistantActionApprovals.actionId, action.id))
      .catch((e) => e);
    expect(causeMessage(error)).toMatch(/append-only/);
  });

  it("rejects a DELETE of an audit event", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);

    const error = await db
      .delete(assistantActionAuditEvents)
      .where(eq(assistantActionAuditEvents.actionId, action.id))
      .catch((e) => e);
    expect(causeMessage(error)).toMatch(/append-only/);
  });

  it("rejects mutating an immutable pending-action column", async () => {
    const { identityId, sessionId } = await identityWithSession();
    const action = await pendingActionFor(identityId, sessionId);

    const error = await db
      .update(assistantPendingActions)
      .set({ canonicalPayload: "tampered" })
      .where(eq(assistantPendingActions.id, action.id))
      .catch((e) => e);
    expect(causeMessage(error)).toMatch(/immutable/);
  });
});
