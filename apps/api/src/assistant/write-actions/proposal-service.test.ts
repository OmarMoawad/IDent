import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { assistantPendingActions, sessions } from "../../db/schema.js";
import { insertConnectedSource, upsertMessage } from "../../comms/store.js";
import type { RetrievedReference } from "../assistant-intent.js";
import { DbActionProposalSink, ProposalError } from "./proposal-service.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function identityWithMessage() {
  app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `prop_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  const { identityId } = response.json() as { identityId: string };
  const [session] = await db.select().from(sessions).where(eq(sessions.identityId, identityId));
  const source = await insertConnectedSource({ identityId, provider: "gmail" });
  const message = await upsertMessage({
    identityId,
    sourceId: source.id,
    externalId: `ext-${randomUUID()}`,
    subject: "Invoice 5512",
    body: "total 12",
    participants: JSON.stringify({ from: [{ name: "Jane Doe", address: "jane@example.com" }], to: [] }),
    occurredAt: new Date(Date.UTC(2026, 7, 1)),
  });
  const refs: RetrievedReference[] = [{ ref: "message:1", kind: "message", id: message.id }];
  return { identityId, sessionId: session.id, message, refs };
}

describe("DbActionProposalSink", () => {
  it("builds a server-owned reply draft with the recipient derived from the message", async () => {
    const { identityId, sessionId, refs } = await identityWithMessage();
    const sink = new DbActionProposalSink();

    const [preview] = await sink.propose({
      identityId,
      sessionId,
      refs,
      intents: [{ type: "reply.draft", targetRef: "message:1", body: "Thanks!" }],
    });

    expect(preview.summary).toEqual({
      kind: "reply.draft",
      // Derived from the stored sender, never supplied by the model.
      to: "jane@example.com",
      subject: "Re: Invoice 5512",
      body: "Thanks!",
    });

    const [row] = await db
      .select()
      .from(assistantPendingActions)
      .where(eq(assistantPendingActions.id, preview.id));
    expect(row.status).toBe("pending");
    expect(row.identityId).toBe(identityId);
    // The recipient lives in the server-owned payload, not the model's text.
    expect(row.canonicalPayload).toContain("jane@example.com");
    expect(row.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates one pending archive action referencing the slice message", async () => {
    const { identityId, sessionId, refs } = await identityWithMessage();
    const sink = new DbActionProposalSink();

    const [preview] = await sink.propose({
      identityId,
      sessionId,
      refs,
      intents: [{ type: "message.archive", targetRefs: ["message:1"] }],
    });

    expect(preview.summary).toEqual({ kind: "message.archive", count: 1 });
    expect(await db.select().from(assistantPendingActions).where(eq(assistantPendingActions.id, preview.id))).toHaveLength(1);
  });

  it("rejects a target that is not in the retrieval slice", async () => {
    const { identityId, sessionId, refs } = await identityWithMessage();
    const sink = new DbActionProposalSink();

    await expect(
      sink.propose({
        identityId,
        sessionId,
        refs,
        intents: [{ type: "message.archive", targetRefs: ["message:99"] }],
      }),
    ).rejects.toThrow(/retrieval slice/i);
    expect(await db.select().from(assistantPendingActions)).toBeInstanceOf(Array);
  });

  it("refuses to reference another identity's message even if the id is guessed", async () => {
    const a = await identityWithMessage();
    const sink = new DbActionProposalSink();
    // A ref whose id belongs to a different identity's record.
    const forgedRefs: RetrievedReference[] = [{ ref: "message:1", kind: "message", id: randomUUID() }];

    await expect(
      sink.propose({
        identityId: a.identityId,
        sessionId: a.sessionId,
        refs: forgedRefs,
        intents: [{ type: "message.archive", targetRefs: ["message:1"] }],
      }),
    ).rejects.toBeInstanceOf(ProposalError);
  });
});
