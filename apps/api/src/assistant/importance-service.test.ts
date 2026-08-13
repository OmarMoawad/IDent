import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { insertConnectedSource, upsertMessage } from "../comms/store.js";
import { classifyMessage } from "./importance-service.js";

async function register(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `imp_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  return response.json() as { identityId: string; sessionToken: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function participants(from: string, to: string[] = ["me@example.com"]) {
  return JSON.stringify({ from: [{ address: from }], to: to.map((address) => ({ address })) });
}

describe("classifyMessage", () => {
  it("always gives a human-readable reason, whatever the level", () => {
    // The roadmap forbids silent filtering — an unexplained call is the
    // thing it rules out, so every branch must produce a reason.
    for (const body of ["Payment failed, action required", "unsubscribe from our newsletter", "just a note"]) {
      const result = classifyMessage({ subject: null, snippet: null, body, participants: null });
      expect(result.reason.length).toBeGreaterThan(10);
    }
  });

  it("flags time-critical mail as high", () => {
    const result = classifyMessage({
      subject: "Payment failed — action required",
      snippet: null,
      body: null,
      participants: participants("billing@example.com"),
    });
    expect(result.level).toBe("high");
  });

  it("treats bulk mail as low without hiding it", () => {
    const result = classifyMessage({
      subject: "Our monthly newsletter",
      snippet: "unsubscribe here",
      body: null,
      participants: participants("no-reply@example.com"),
    });
    expect(result.level).toBe("low");
  });

  it("treats a direct question to you alone as high", () => {
    const result = classifyMessage({
      subject: "Quick one",
      snippet: null,
      body: "Can you review this today?",
      participants: participants("jane@example.com", ["me@example.com"]),
    });
    expect(result.level).toBe("high");
  });

  it("treats a large group thread as low", () => {
    const result = classifyMessage({
      subject: "All-hands notes",
      snippet: null,
      body: "Notes attached.",
      participants: participants("chief@example.com", Array.from({ length: 8 }, (_, i) => `p${i}@example.com`)),
    });
    expect(result.level).toBe("low");
  });
});

describe("importance routes", () => {
  it("requires authentication", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/identity/priorities" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/identity/priorities/classify" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/identity/priority-rules" })).statusCode).toBe(401);
    await app.close();
  });

  it("labels messages without removing any of them from the inbox", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    for (const [index, subject] of ["Newsletter — unsubscribe", "Payment failed"].entries()) {
      await upsertMessage({
        identityId: identity.identityId,
        sourceId: source.id,
        externalId: `m-${index}`,
        subject,
        participants: participants("someone@example.com"),
        occurredAt: new Date(Date.UTC(2026, 7, 1 + index)),
      });
    }

    const classify = await app.inject({
      method: "POST",
      url: "/identity/priorities/classify",
      headers: bearer(identity.sessionToken),
    });
    expect(classify.json().classified).toBe(2);

    // The crucial property: the message list is unchanged. Filtering is
    // never applied server-side — priorities are a separate annotation.
    const messages = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(messages.json()).toHaveLength(2);

    const priorities = await app.inject({
      method: "GET",
      url: "/identity/priorities",
      headers: bearer(identity.sessionToken),
    });
    expect(priorities.json()).toHaveLength(2);
    // Every call is explained.
    expect(priorities.json().every((p: { reason: string }) => p.reason.length > 0)).toBe(true);
    await app.close();
  });

  it("lets a user rule override the assistant's guess", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "bulk-1",
      subject: "Newsletter — unsubscribe",
      participants: participants("digest@example.com"),
      occurredAt: new Date("2026-08-01T10:00:00Z"),
    });

    await app.inject({ method: "POST", url: "/identity/priorities/classify", headers: bearer(identity.sessionToken) });
    const before = await app.inject({ method: "GET", url: "/identity/priorities", headers: bearer(identity.sessionToken) });
    expect(before.json()[0].level).toBe("low");

    // The user says this sender matters. Stated preference must beat the guess.
    await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(identity.sessionToken),
      payload: { matchType: "contact", matchValue: "digest@example.com", level: "high" },
    });
    await app.inject({ method: "POST", url: "/identity/priorities/classify", headers: bearer(identity.sessionToken) });

    const after = await app.inject({ method: "GET", url: "/identity/priorities", headers: bearer(identity.sessionToken) });
    expect(after.json()[0]).toMatchObject({ level: "high", assignedBy: "rule" });
    // And the reason names the rule, so the user can find what to change.
    expect(after.json()[0].reason).toContain("digest@example.com");
    await app.close();
  });

  it("keeps a per-message override across re-classification", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    const message = await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "one",
      subject: "Newsletter — unsubscribe",
      participants: participants("digest@example.com"),
      occurredAt: new Date("2026-08-01T10:00:00Z"),
    });

    await app.inject({ method: "POST", url: "/identity/priorities/classify", headers: bearer(identity.sessionToken) });
    await app.inject({
      method: "POST",
      url: `/identity/priorities/${message.id}`,
      headers: bearer(identity.sessionToken),
      payload: { level: "high" },
    });

    // Re-running the classifier must not quietly revert the user's call.
    await app.inject({ method: "POST", url: "/identity/priorities/classify", headers: bearer(identity.sessionToken) });
    const after = await app.inject({ method: "GET", url: "/identity/priorities", headers: bearer(identity.sessionToken) });
    expect(after.json()[0]).toMatchObject({ level: "high", assignedBy: "user" });
    await app.close();
  });

  it("rejects an invalid level and an unknown message", async () => {
    const app = buildApp();
    const identity = await register(app);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/identity/priorities/${randomUUID()}`,
          headers: bearer(identity.sessionToken),
          payload: { level: "urgent" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/identity/priorities/${randomUUID()}`,
          headers: bearer(identity.sessionToken),
          payload: { level: "high" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("keeps rules and overrides tenant-isolated", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);

    const created = await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(alice.sessionToken),
      payload: { matchType: "contact", matchValue: "jane@example.com", level: "high" },
    });
    const ruleId = created.json().id;

    expect((await app.inject({ method: "GET", url: "/identity/priority-rules", headers: bearer(bob.sessionToken) })).json()).toEqual([]);
    expect(
      (await app.inject({ method: "DELETE", url: `/identity/priority-rules/${ruleId}`, headers: bearer(bob.sessionToken) }))
        .statusCode,
    ).toBe(404);
    // Alice's rule survives Bob's attempt.
    expect((await app.inject({ method: "GET", url: "/identity/priority-rules", headers: bearer(alice.sessionToken) })).json()).toHaveLength(1);
    await app.close();
  });

  it("lets the user delete a rule they no longer want", async () => {
    const app = buildApp();
    const identity = await register(app);
    const created = await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(identity.sessionToken),
      payload: { matchType: "contact", matchValue: "jane@example.com", level: "low" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/identity/priority-rules/${created.json().id}`,
      headers: bearer(identity.sessionToken),
    });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });
});

describe("review findings 5 & 6", () => {
  it("classifies and overrides a message older than the newest 100", async () => {
    // Finding 5: classification read the inbox's capped query, so an older
    // owned message could never be classified and could not be overridden
    // — the API returned a misleading 404 for mail the user can plainly see.
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });

    const oldest = await upsertMessage({
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "ancient",
      subject: "Ancient invoice",
      participants: participants("billing@example.com"),
      occurredAt: new Date("2020-01-01T00:00:00Z"),
    });
    for (let index = 0; index < 120; index++) {
      await upsertMessage({
        identityId: identity.identityId,
        sourceId: source.id,
        externalId: `recent-${index}`,
        subject: `Recent ${index}`,
        participants: participants("someone@example.com"),
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      });
    }

    const classify = await app.inject({
      method: "POST",
      url: "/identity/priorities/classify",
      headers: bearer(identity.sessionToken),
    });
    expect(classify.json().classified).toBe(121);

    const priorities = await app.inject({
      method: "GET",
      url: "/identity/priorities",
      headers: bearer(identity.sessionToken),
    });
    expect(priorities.json().some((p: { messageId: string }) => p.messageId === oldest.id)).toBe(true);

    // And it can be overridden rather than 404ing.
    const override = await app.inject({
      method: "POST",
      url: `/identity/priorities/${oldest.id}`,
      headers: bearer(identity.sessionToken),
      payload: { level: "high" },
    });
    expect(override.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a contact rule that is not an email address", async () => {
    const app = buildApp();
    const identity = await register(app);
    const response = await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(identity.sessionToken),
      payload: { matchType: "contact", matchValue: "not-an-address", level: "low" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an oversized matchValue", async () => {
    const app = buildApp();
    const identity = await register(app);
    const response = await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(identity.sessionToken),
      payload: { matchType: "contact", matchValue: `${"x".repeat(320)}@example.com`, level: "low" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a source rule pointing at a source the identity does not own", async () => {
    // Finding 6: a dead rule silently never matches, so the user believes
    // they've tuned something and nothing changes.
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const bobSource = await insertConnectedSource({ identityId: bob.identityId, provider: "gmail" });

    const foreign = await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(alice.sessionToken),
      payload: { matchType: "source", matchValue: bobSource.id, level: "low" },
    });
    expect(foreign.statusCode).toBe(404);

    // Alice's own source is accepted.
    const own = await insertConnectedSource({ identityId: alice.identityId, provider: "gmail" });
    const valid = await app.inject({
      method: "POST",
      url: "/identity/priority-rules",
      headers: bearer(alice.sessionToken),
      payload: { matchType: "source", matchValue: own.id, level: "low" },
    });
    expect(valid.statusCode).toBe(201);
    await app.close();
  });
});
