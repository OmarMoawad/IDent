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

  // Objective 0 review, 2026-08-14. The question IDent_STATE.md left for
  // the reviewer was whether any way to distinguish a live token from a
  // dead one survived the uniform-202 change. One did, and it was
  // reachable from the wire: a NUL byte passes every check in
  // requireString, and Postgres then rejects the parameter as invalid
  // UTF-8. That threw a DrizzleQueryError, which was not an
  // InvalidNotificationError and so was rethrown as a 500 — reachable only
  // with a live token, because a dead one returns before any write.
  it("answers 202 for a NUL byte too, which used to 500 only for a live token", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    const nul = String.fromCharCode(0);

    const live = await ingest(app, token, { app: "GitHub", title: `pull${nul}request` });
    const dead = await ingest(app, "never-issued-token", { app: "GitHub", title: `pull${nul}request` });

    for (const response of [live, dead]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "accepted" });
    }
    await app.close();
  });

  it("treats a NUL byte as the sender's malformed input, not an internal fault", async () => {
    // The distinction matters to the owner reading lastError: "we could not
    // store this" and "you sent something invalid" are different debugging
    // stories, and this one is the sender's.
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);

    await ingest(app, token, { app: "GitHub", title: `pull${String.fromCharCode(0)}request` });
    const status = await app.inject({
      method: "GET",
      url: "/identity/notifications/endpoint",
      headers: bearer(identity.sessionToken),
    });
    expect(status.json().lastError).toMatch(/NUL bytes/);
    await app.close();
  });

  it("stores a notification whose optional fields carry NUL bytes", async () => {
    // body and externalId are forgiving fields, so they are stripped rather
    // than refused — a delivery that is otherwise fine still lands.
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    const nul = String.fromCharCode(0);

    const response = await ingest(app, token, {
      app: "GitHub",
      title: "Review requested",
      body: `merge${nul}conflict`,
      externalId: `pr${nul}42`,
    });
    expect(response.statusCode).toBe(202);

    const status = await app.inject({
      method: "GET",
      url: "/identity/notifications/endpoint",
      headers: bearer(identity.sessionToken),
    });
    // Nothing was rejected, so no error was recorded against the endpoint.
    expect(status.json().lastError).toBeNull();
    await app.close();
  });

  it("retires a recorded rejection once a delivery succeeds", async () => {
    // Session 22 click-through: lastError was only cleared by regenerating
    // the token, so one malformed payload left "Last delivery rejected" on
    // the inbox forever — including after four good deliveries. The banner
    // must describe the current state, not the worst thing that ever
    // happened to this endpoint.
    const app = buildApp();
    const identity = await register(app);
    const { token } = await mintToken(app, identity.sessionToken);
    const readStatus = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/identity/notifications/endpoint",
          headers: bearer(identity.sessionToken),
        })
      ).json();

    await ingest(app, token, { app: "GitHub" });
    expect((await readStatus()).lastError).toMatch(/title is required/);

    await ingest(app, token, validPayload);

    const status = await readStatus();
    expect(status.lastError).toBeNull();
    expect(status.lastErrorAt).toBeNull();
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
