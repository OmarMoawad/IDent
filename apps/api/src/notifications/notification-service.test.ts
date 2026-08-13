import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notificationEndpoints } from "../db/schema.js";
import { hashToken, NOTIFICATION_TOKEN_HEADER, safeActionUrl, InvalidNotificationError } from "./notification-service.js";

async function register(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `ntf_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  return response.json() as { identityId: string; sessionToken: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Minting is a POST now — the plaintext is returned exactly once. */
async function mintToken(app: FastifyInstance, sessionToken: string) {
  const response = await app.inject({
    method: "POST",
    url: "/identity/notifications/endpoint",
    headers: bearer(sessionToken),
  });
  return response.json() as { token: string; path: string; header: string };
}

/** Delivery via the header — the form that keeps the credential out of URLs. */
function ingest(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/notifications/ingest",
    headers: { [NOTIFICATION_TOKEN_HEADER]: token },
    payload,
  });
}

const validPayload = { app: "GitHub", title: "Review requested", body: "on PR #12" };

describe("safeActionUrl", () => {
  it("accepts http and https", () => {
    expect(safeActionUrl("https://example.com/pr/1")).toBe("https://example.com/pr/1");
    expect(safeActionUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects javascript: and data: URLs", () => {
    // Stored XSS if this ever reached an href, and the value comes from
    // outside the system.
    for (const hostile of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      expect(() => safeActionUrl(hostile)).toThrow(InvalidNotificationError);
    }
  });

  it("rejects a non-absolute URL and allows omission", () => {
    expect(() => safeActionUrl("/relative/path")).toThrow(InvalidNotificationError);
    expect(safeActionUrl(undefined)).toBeNull();
    expect(safeActionUrl("")).toBeNull();
  });
});

describe("notification endpoint", () => {
  it("requires authentication", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/identity/notifications/endpoint" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/identity/notifications/endpoint" })).statusCode).toBe(401);
    await app.close();
  });

  it("stores only a hash and never returns the token again", async () => {
    const app = buildApp();
    const identity = await register(app);
    const minted = await mintToken(app, identity.sessionToken);
    expect(minted.token.length).toBeGreaterThan(20);

    // The status endpoint knows an endpoint exists but cannot reveal it.
    const status = await app.inject({
      method: "GET",
      url: "/identity/notifications/endpoint",
      headers: bearer(identity.sessionToken),
    });
    expect(status.json().configured).toBe(true);
    expect(JSON.stringify(status.json())).not.toContain(minted.token);

    // And what is stored is the hash, not the credential.
    const stored = await db
      .select({ tokenHash: notificationEndpoints.tokenHash })
      .from(notificationEndpoints)
      .where(eq(notificationEndpoints.identityId, identity.identityId));
    expect(stored[0].tokenHash).toBe(hashToken(minted.token));
    expect(stored[0].tokenHash).not.toBe(minted.token);
    await app.close();
  });

  it("rotation revokes the previous token", async () => {
    const app = buildApp();
    const identity = await register(app);
    const first = await mintToken(app, identity.sessionToken);
    const second = await mintToken(app, identity.sessionToken);
    expect(second.token).not.toBe(first.token);

    // The old token now delivers nothing — rotation is revocation.
    await ingest(app, first.token, validPayload);
    await ingest(app, second.token, validPayload);
    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toHaveLength(1);
    await app.close();
  });

  it("gives different identities different tokens", async () => {
    const app = buildApp();
    const alice = await mintToken(app, (await register(app)).sessionToken);
    const bob = await mintToken(app, (await register(app)).sessionToken);
    expect(alice.token).not.toBe(bob.token);
    await app.close();
  });
});

describe("the ingest endpoint reveals nothing about the token", () => {
  it("answers 202 identically for unknown, valid, and malformed", async () => {
    // The earlier version returned 202/201/400 and was *described* as
    // non-diagnostic. It wasn't: a malformed payload distinguished a live
    // token from a dead one in one request. All three must now match.
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    const unknown = await ingest(app, "never-issued-token", validPayload);
    const valid = await ingest(app, token, validPayload);
    const malformed = await ingest(app, token, { app: "GitHub" });

    for (const response of [unknown, valid, malformed]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "accepted" });
    }
    await app.close();
  });

  it("still lets the owner see why a delivery was rejected", async () => {
    // The sender learns nothing; the owner must still be able to debug.
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    await ingest(app, token, { app: "GitHub" });
    const status = await app.inject({
      method: "GET",
      url: "/identity/notifications/endpoint",
      headers: bearer(identity.sessionToken),
    });
    expect(status.json().lastError).toMatch(/title is required/);
    await app.close();
  });
});

describe("notification ingestion", () => {
  it("accepts a notification and lists it in the unified inbox", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    expect((await ingest(app, token, validPayload)).statusCode).toBe(202);

    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0]).toMatchObject({ subject: "Review requested", kind: "notification" });
    await app.close();
  });

  it("also accepts the token in the URL for senders that cannot set headers", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    const response = await app.inject({ method: "POST", url: `/notifications/ingest/${token}`, payload: validPayload });
    expect(response.statusCode).toBe(202);
    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toHaveLength(1);
    await app.close();
  });

  it("segments by kind without hiding anything by default", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    await ingest(app, token, validPayload);

    const listFor = async (query: string) =>
      (await app.inject({ method: "GET", url: `/identity/messages${query}`, headers: bearer(identity.sessionToken) })).json();

    expect(await listFor("")).toHaveLength(1);
    expect(await listFor("?kind=notification")).toHaveLength(1);
    expect(await listFor("?kind=message")).toHaveLength(0);

    const bad = await app.inject({
      method: "GET",
      url: "/identity/messages?kind=everything",
      headers: bearer(identity.sessionToken),
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("is idempotent when the sender supplies its own id", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    const payload = { ...validPayload, externalId: "pr-12-review" };

    await ingest(app, token, payload);
    await ingest(app, token, { ...payload, title: "Review requested (updated)" });

    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0].subject).toBe("Review requested (updated)");
    await app.close();
  });

  it("creates exactly one pseudo-source under concurrent first deliveries", async () => {
    // find-then-insert raced: the uniqueness constraint includes a nullable
    // providerAccountId, and Postgres treats NULLs as distinct, so both
    // callers inserted.
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ingest(app, token, { ...validPayload, externalId: `concurrent-${index}` }),
      ),
    );

    const sources = await app.inject({
      method: "GET",
      url: "/identity/connections",
      headers: bearer(identity.sessionToken),
    });
    const pseudo = sources.json().filter((source: { provider: string }) => source.provider === "notifications");
    expect(pseudo).toHaveLength(1);
    await app.close();
  });

  it("never delivers one identity's notification to another", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const { token } = await mintToken(app, alice.sessionToken);

    await ingest(app, token, { ...validPayload, title: "Alice only" });

    const bobInbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(bob.sessionToken),
    });
    expect(bobInbox.json()).toEqual([]);
    await app.close();
  });

  it("rejects a hostile actionUrl without storing anything", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    await ingest(app, token, { ...validPayload, actionUrl: "javascript:alert(1)" });

    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toEqual([]);
    await app.close();
  });

  it("bounds an oversized title", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    await ingest(app, token, { ...validPayload, title: "x".repeat(301) });

    const status = await app.inject({
      method: "GET",
      url: "/identity/notifications/endpoint",
      headers: bearer(identity.sessionToken),
    });
    expect(status.json().lastError).toMatch(/300 characters/);
    await app.close();
  });

  it("is searchable like any other item", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    await ingest(app, token, { app: "Linear", title: "Ticket ENG-42 assigned", body: "deploy pipeline" });

    const search = await app.inject({
      method: "GET",
      url: "/identity/messages?query=ENG-42",
      headers: bearer(identity.sessionToken),
    });
    expect(search.json()).toHaveLength(1);
    await app.close();
  });
});
