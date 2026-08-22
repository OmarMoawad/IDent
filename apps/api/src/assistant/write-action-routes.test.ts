import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { digestCanonical } from "./write-actions/canonical-json.js";
import { createPendingAction } from "./write-actions/store.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function identity() {
  const response = await app!.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `wa_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  const { identityId, sessionToken } = response.json() as { identityId: string; sessionToken: string };
  const [session] = await db.select().from(sessions).where(eq(sessions.identityId, identityId));
  return { identityId, sessionToken, sessionId: session.id, auth: { authorization: `Bearer ${sessionToken}` } };
}

async function pendingArchive(identityId: string, sessionId: string) {
  const payload = { type: "message.archive", schemaVersion: 1, targets: [{ sourceId: "s", providerMessageId: "m" }] };
  return createPendingAction({
    identityId,
    requestingSessionId: sessionId,
    actionType: "message.archive",
    schemaVersion: 1,
    canonicalPayload: JSON.stringify(payload),
    payloadDigest: digestCanonical(payload),
    retrievalSlice: "[]",
    preconditions: "{}",
    operationKey: randomUUID(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
}

describe("write action routes", () => {
  it("rejects an unauthenticated caller", async () => {
    app = buildApp();
    const me = await identity();
    const action = await pendingArchive(me.identityId, me.sessionId);
    const response = await app.inject({ method: "GET", url: `/identity/assistant/actions/${action.id}` });
    expect(response.statusCode).toBe(401);
  });

  it("hides another identity's action behind a 404", async () => {
    app = buildApp();
    const owner = await identity();
    const stranger = await identity();
    const action = await pendingArchive(owner.identityId, owner.sessionId);

    const response = await app.inject({
      method: "POST",
      url: `/identity/assistant/actions/${action.id}/confirm`,
      headers: stranger.auth,
      payload: { payloadDigest: action.payloadDigest },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a stale digest with 409 and leaves the action pending", async () => {
    app = buildApp();
    const owner = await identity();
    const action = await pendingArchive(owner.identityId, owner.sessionId);

    const response = await app.inject({
      method: "POST",
      url: `/identity/assistant/actions/${action.id}/confirm`,
      headers: owner.auth,
      payload: { payloadDigest: "stale" },
    });
    expect(response.statusCode).toBe(409);

    const view = await app.inject({
      method: "GET",
      url: `/identity/assistant/actions/${action.id}`,
      headers: owner.auth,
    });
    expect(view.json().status).toBe("pending");
  });

  it("confirms, then executes through the injected executor path", async () => {
    app = buildApp();
    const owner = await identity();
    const action = await pendingArchive(owner.identityId, owner.sessionId);

    const confirm = await app.inject({
      method: "POST",
      url: `/identity/assistant/actions/${action.id}/confirm`,
      headers: owner.auth,
      payload: { payloadDigest: action.payloadDigest },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("approved");

    // The default executor is the not-configured stub, which exercises the
    // full claim → execute → record path and lands the action in a terminal
    // state — proving the route wiring, without needing a live provider.
    const execute = await app.inject({
      method: "POST",
      url: `/identity/assistant/actions/${action.id}/execute`,
      headers: owner.auth,
      payload: { payloadDigest: action.payloadDigest },
    });
    expect(execute.statusCode).toBe(200);
    const body = execute.json();
    expect(body.status).toBe("failed");
    expect(body.outcomeCode).toBe("executor_not_configured");
  });

  it("cancels a pending action", async () => {
    app = buildApp();
    const owner = await identity();
    const action = await pendingArchive(owner.identityId, owner.sessionId);

    const response = await app.inject({
      method: "POST",
      url: `/identity/assistant/actions/${action.id}/cancel`,
      headers: owner.auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelled");
  });
});
