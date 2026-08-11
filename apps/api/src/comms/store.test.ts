import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  findConnectedSourcesByIdentity,
  findMessageByIdForIdentity,
  findMessagesByIdentity,
  insertConnectedSource,
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
