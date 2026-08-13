import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { insertConnectedSource, upsertMessage } from "./store.js";

async function register(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `contacts_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  return response.json() as { identityId: string; sessionToken: string };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function participants(from: Array<{ name?: string; address: string }>, to: Array<{ address: string }> = []) {
  return JSON.stringify({ from, to });
}

describe("Contact card routes", () => {
  it("requires authentication on every contact route", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/identity/contacts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/identity/contacts/rebuild" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/identity/contacts/${randomUUID()}` })).statusCode).toBe(401);
    await app.close();
  });

  it("derives searchable contacts from synced messages and excludes the user's own address", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({
      identityId: identity.identityId,
      provider: "gmail",
      status: "connected",
      providerAccountId: "account-1",
      providerAccountEmail: "me@example.com",
    });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "m1",
      subject: "Lunch",
      participants: participants([{ name: "Jane Doe", address: "jane@example.com" }], [{ address: "me@example.com" }]),
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });

    const rebuild = await app.inject({
      method: "POST",
      url: "/identity/contacts/rebuild",
      headers: bearer(identity.sessionToken),
    });
    expect(rebuild.statusCode).toBe(200);
    expect(rebuild.json()).toMatchObject({ contactCount: 1, messagesScanned: 1 });

    const list = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(identity.sessionToken) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ address: "jane@example.com", displayName: "Jane Doe", messageCount: 1 });
    // The identity's own mailbox is not a contact.
    expect(JSON.stringify(list.json())).not.toContain("me@example.com");
    // identityId is never echoed back on the wire.
    expect(Object.keys(list.json()[0]).sort()).toEqual([
      "address",
      "displayName",
      "firstSeenAt",
      "id",
      "lastSeenAt",
      "messageCount",
    ]);

    const search = await app.inject({
      method: "GET",
      url: "/identity/contacts?query=JANE",
      headers: bearer(identity.sessionToken),
    });
    expect(search.json()).toHaveLength(1);
    const miss = await app.inject({
      method: "GET",
      url: "/identity/contacts?query=nobody",
      headers: bearer(identity.sessionToken),
    });
    expect(miss.json()).toEqual([]);
    await app.close();
  });

  it("returns a contact's own recent messages on the detail route", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "m1",
      subject: "From Jane",
      participants: participants([{ address: "jane@example.com" }]),
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "m2",
      subject: "From Bob",
      participants: participants([{ address: "bob@example.com" }]),
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(identity.sessionToken) });

    const list = await app.inject({ method: "GET", url: "/identity/contacts?query=jane@example.com", headers: bearer(identity.sessionToken) });
    const detail = await app.inject({
      method: "GET",
      url: `/identity/contacts/${list.json()[0].id}`,
      headers: bearer(identity.sessionToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toHaveLength(1);
    expect(detail.json().messages[0].subject).toBe("From Jane");
    await app.close();
  });

  it("keeps one identity's contacts invisible and unreachable from another", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const source = await insertConnectedSource({ identityId: alice.identityId, provider: "gmail" });
    await upsertMessage({
      identityId: alice.identityId,
      sourceId: source.id,
      externalId: "m1",
      participants: participants([{ address: "private@example.com" }]),
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(alice.sessionToken) });

    const aliceList = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(alice.sessionToken) });
    const contactId = aliceList.json()[0].id;

    const bobList = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(bob.sessionToken) });
    expect(bobList.json()).toEqual([]);
    // Cross-tenant read is indistinguishable from a missing record.
    const bobDetail = await app.inject({ method: "GET", url: `/identity/contacts/${contactId}`, headers: bearer(bob.sessionToken) });
    expect(bobDetail.statusCode).toBe(404);
    // Rebuilding as another identity must not delete Alice's rows.
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(bob.sessionToken) });
    const aliceAfter = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(alice.sessionToken) });
    expect(aliceAfter.json()).toHaveLength(1);
    await app.close();
  });

  it("rebuilds idempotently rather than duplicating contacts", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "m1",
      participants: participants([{ address: "jane@example.com" }]),
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(identity.sessionToken) });
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(identity.sessionToken) });
    const list = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(identity.sessionToken) });
    expect(list.json()).toHaveLength(1);
    await app.close();
  });

  it("keeps contacts that only appear in mail older than the newest 100 messages", async () => {
    // Regression: derivation used to read the inbox's newest-100 window and
    // then replace the whole contact set, so anyone who hadn't emailed
    // recently was deleted, and counts/first-seen drifted as the window moved.
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });

    // One old message from a contact who never appears again...
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "old-1",
      subject: "Ancient history",
      participants: participants([{ name: "Old Friend", address: "old.friend@example.com" }]),
      occurredAt: new Date("2020-01-01T10:00:00Z"),
    });
    // ...buried under more than a full window of newer mail.
    for (let index = 0; index < 120; index++) {
      await upsertMessage({
        identityId: identity.identityId,
        sourceId: source.id,
        externalId: `recent-${index}`,
        subject: `Recent ${index}`,
        participants: participants([{ address: "busy@example.com" }]),
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      });
    }

    const rebuild = await app.inject({
      method: "POST",
      url: "/identity/contacts/rebuild",
      headers: bearer(identity.sessionToken),
    });
    expect(rebuild.json().messagesScanned).toBe(121);

    const list = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(identity.sessionToken) });
    const byAddress = Object.fromEntries(list.json().map((contact: { address: string }) => [contact.address, contact]));
    expect(byAddress["old.friend@example.com"]).toBeDefined();
    // The whole mailbox is counted, not one window of it.
    expect(byAddress["busy@example.com"].messageCount).toBe(120);
    expect(byAddress["busy@example.com"].firstSeenAt).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString());

    // And the old contact's own messages are still reachable on detail,
    // even though they fall outside the newest-100 window.
    const detail = await app.inject({
      method: "GET",
      url: `/identity/contacts/${byAddress["old.friend@example.com"].id}`,
      headers: bearer(identity.sessionToken),
    });
    expect(detail.json().messages).toHaveLength(1);
    expect(detail.json().messages[0].subject).toBe("Ancient history");

    // Rebuilding again must be stable, not erode history.
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(identity.sessionToken) });
    const after = await app.inject({ method: "GET", url: "/identity/contacts", headers: bearer(identity.sessionToken) });
    expect(after.json()).toHaveLength(2);
    await app.close();
  });

  it("does not let a substring address match another contact's messages", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "sub-1",
      subject: "To the longer address",
      participants: participants([{ address: "notjane@example.com" }]),
      occurredAt: new Date("2026-08-10T10:00:00Z"),
    });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "sub-2",
      subject: "To Jane",
      participants: participants([{ address: "jane@example.com" }]),
      occurredAt: new Date("2026-08-11T10:00:00Z"),
    });
    await app.inject({ method: "POST", url: "/identity/contacts/rebuild", headers: bearer(identity.sessionToken) });

    const list = await app.inject({
      method: "GET",
      url: "/identity/contacts?query=jane@example.com",
      headers: bearer(identity.sessionToken),
    });
    const jane = list.json().find((contact: { address: string }) => contact.address === "jane@example.com");
    const detail = await app.inject({
      method: "GET",
      url: `/identity/contacts/${jane.id}`,
      headers: bearer(identity.sessionToken),
    });
    expect(detail.json().messages.map((message: { subject: string }) => message.subject)).toEqual(["To Jane"]);
    await app.close();
  });

  it("bounds the search query", async () => {
    const app = buildApp();
    const identity = await register(app);
    const response = await app.inject({
      method: "GET",
      url: `/identity/contacts?query=${"x".repeat(201)}`,
      headers: bearer(identity.sessionToken),
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
