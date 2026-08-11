import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { db } from "../db/client.js";
import { connectedSources } from "../db/schema.js";
import {
  clearConnectedSourceTokens,
  consumeOauthStateChallenge,
  findConnectedSourceById,
  findConnectedSourcesByIdentity,
  findMessageByIdForIdentity,
  findMessagesByIdentity,
  insertConnectedSource,
  insertOauthStateChallenge,
  setConnectedSourceTokens,
  upsertMessage,
} from "./store.js";

// No comms HTTP routes exist yet this session (see schema.ts's comment on
// connected_sources/messages) — registration is the one identity-creation
// path available, reused here via app.inject() rather than duplicating
// identity/store.ts's createIdentity transaction logic in a second place.
async function createTestIdentity(app: FastifyInstance): Promise<string> {
  const username = `comms_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: { username, password: "correct horse battery staple", wrappedAmkKey: "placeholder-amk-wrap" },
  });
  return response.json().identityId as string;
}

describe("comms/store: connected sources", () => {
  it("inserts a connected source and scopes lookup by identity", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);

    const source = await insertConnectedSource({ identityId, provider: "gmail" });
    expect(source.provider).toBe("gmail");
    expect(source.status).toBe("pending");

    const found = await findConnectedSourcesByIdentity(identityId);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(source.id);

    await app.close();
  });

  it("never returns another identity's connected sources", async () => {
    const app = buildApp();
    const identityA = await createTestIdentity(app);
    const identityB = await createTestIdentity(app);

    await insertConnectedSource({ identityId: identityA, provider: "gmail" });

    const foundForB = await findConnectedSourcesByIdentity(identityB);
    expect(foundForB).toHaveLength(0);

    await app.close();
  });

  it("defaults status to pending, but accepts an explicit override", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);

    const source = await insertConnectedSource({ identityId, provider: "gmail", status: "connected" });
    expect(source.status).toBe("connected");

    await app.close();
  });
});

describe("comms/store: messages", () => {
  it("upserts a message and finds it scoped by identity", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });

    const inserted = await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "msg-1",
      subject: "Hello",
      snippet: "Hi there",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });
    expect(inserted.subject).toBe("Hello");
    expect(inserted.isRead).toBe(false);

    const found = await findMessagesByIdentity(identityId);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(inserted.id);

    await app.close();
  });

  it("is idempotent on (sourceId, externalId): re-syncing updates content, not a duplicate row", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });

    await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "msg-2",
      subject: "Original subject",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });
    const resynced = await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "msg-2",
      subject: "Corrected subject",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });

    const found = await findMessagesByIdentity(identityId);
    expect(found).toHaveLength(1);
    expect(found[0].subject).toBe("Corrected subject");
    expect(found[0].id).toBe(resynced.id);

    await app.close();
  });

  it("re-syncing an already-read message does not silently mark it unread again", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });

    await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "msg-3",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
      isRead: true,
    });
    await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "msg-3",
      subject: "Updated on resync",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });

    const found = await findMessagesByIdentity(identityId);
    expect(found[0].isRead).toBe(true);

    await app.close();
  });

  it("orders messages newest-first by occurredAt", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });

    await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "older",
      occurredAt: new Date("2026-08-01T10:00:00Z"),
    });
    await upsertMessage({
      identityId,
      sourceId: source.id,
      externalId: "newer",
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });

    const found = await findMessagesByIdentity(identityId);
    expect(found.map((m) => m.externalId)).toEqual(["newer", "older"]);

    await app.close();
  });

  it("never returns another identity's messages, even by direct id lookup", async () => {
    const app = buildApp();
    const identityA = await createTestIdentity(app);
    const identityB = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId: identityA, provider: "gmail" });

    const message = await upsertMessage({
      identityId: identityA,
      sourceId: source.id,
      externalId: "private-to-a",
      occurredAt: new Date(),
    });

    const foundForB = await findMessagesByIdentity(identityB);
    expect(foundForB).toHaveLength(0);

    const directLookupByB = await findMessageByIdForIdentity(message.id, identityB);
    expect(directLookupByB).toBeNull();

    const directLookupByA = await findMessageByIdForIdentity(message.id, identityA);
    expect(directLookupByA?.id).toBe(message.id);

    await app.close();
  });

  it("rejects inserting a message with a sourceId that belongs to a different identity", async () => {
    // Regression test for a real gap an external review found: identityId
    // and sourceId were two independently-valid foreign keys with nothing
    // tying them to each other, so a bug in a future sync worker could
    // silently write Bob's connected-source messages under Alice's
    // identityId. schema.ts's messages_source_identity_fk (a composite FK
    // against connected_sources' own (id, identityId) unique constraint)
    // makes that combination impossible at the database level.
    const app = buildApp();
    const identityA = await createTestIdentity(app);
    const identityB = await createTestIdentity(app);
    const sourceOwnedByB = await insertConnectedSource({ identityId: identityB, provider: "gmail" });

    await expect(
      upsertMessage({
        identityId: identityA,
        sourceId: sourceOwnedByB.id,
        externalId: "cross-identity-attempt",
        occurredAt: new Date(),
      }),
    ).rejects.toThrow();

    await app.close();
  });
});

describe("comms/store: connected source token lifecycle", () => {
  it("setConnectedSourceTokens marks a source connected", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });

    await setConnectedSourceTokens(source.id, "opaque-encrypted-blob");

    const found = await findConnectedSourceById(source.id);
    expect(found?.status).toBe("connected");

    await app.close();
  });

  it("clearConnectedSourceTokens disconnects and clears the stored tokens, not just the status", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });
    await setConnectedSourceTokens(source.id, "opaque-encrypted-blob");

    await clearConnectedSourceTokens(source.id);

    const found = await findConnectedSourceById(source.id);
    expect(found?.status).toBe("disconnected");
    // ConnectedSource's own return type doesn't project encryptedTokenData
    // (nothing outside comms/store.ts should read it unencrypted-adjacent),
    // so confirm the clear at the row level instead.
    const [raw] = await db
      .select({ encryptedTokenData: connectedSources.encryptedTokenData })
      .from(connectedSources)
      .where(eq(connectedSources.id, source.id));
    expect(raw.encryptedTokenData).toBeNull();

    await app.close();
  });
});

describe("comms/store: OAuth state challenges", () => {
  it("consumes a valid, unexpired state exactly once", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const state = randomUUID();
    const pkceVerifier = randomUUID();
    await insertOauthStateChallenge({
      identityId,
      provider: "gmail",
      state,
      pkceVerifier,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await consumeOauthStateChallenge(state);
    expect(first).toEqual({ identityId, provider: "gmail", pkceVerifier });

    const second = await consumeOauthStateChallenge(state);
    expect(second).toBeNull();

    await app.close();
  });

  it("rejects an unknown state", async () => {
    const result = await consumeOauthStateChallenge(randomUUID());
    expect(result).toBeNull();
  });

  it("rejects an expired state", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const state = randomUUID();
    await insertOauthStateChallenge({
      identityId,
      provider: "gmail",
      state,
      pkceVerifier: randomUUID(),
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await consumeOauthStateChallenge(state);
    expect(result).toBeNull();

    await app.close();
  });

  it("only one of two concurrent consume attempts for the same state wins", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const state = randomUUID();
    await insertOauthStateChallenge({
      identityId,
      provider: "gmail",
      state,
      pkceVerifier: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [first, second] = await Promise.all([consumeOauthStateChallenge(state), consumeOauthStateChallenge(state)]);
    const results = [first, second].filter((r) => r !== null);
    expect(results).toHaveLength(1);

    await app.close();
  });
});
