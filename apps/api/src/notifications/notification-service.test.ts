import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { safeActionUrl, InvalidNotificationError } from "./notification-service.js";

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

async function endpointFor(app: FastifyInstance, sessionToken: string) {
  const response = await app.inject({
    method: "GET",
    url: "/identity/notifications/endpoint",
    headers: bearer(sessionToken),
  });
  return response.json() as { token: string; path: string };
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
    await app.close();
  });

  it("returns a stable opaque token across calls", async () => {
    const app = buildApp();
    const identity = await register(app);

    const first = await endpointFor(app, identity.sessionToken);
    const second = await endpointFor(app, identity.sessionToken);
    // A user who has already pasted this into a third-party service must
    // not have it change underneath them.
    expect(first.token).toBe(second.token);
    expect(first.token.length).toBeGreaterThan(20);
    // Opaque: it must not be derived from anything guessable.
    expect(first.token).not.toContain(identity.identityId);
    await app.close();
  });

  it("gives different identities different tokens", async () => {
    const app = buildApp();
    const alice = await endpointFor(app, (await register(app)).sessionToken);
    const bob = await endpointFor(app, (await register(app)).sessionToken);
    expect(alice.token).not.toBe(bob.token);
    await app.close();
  });
});

describe("notification ingestion", () => {
  it("accepts a notification and lists it in the unified inbox", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { path } = await endpointFor(app, identity.sessionToken);

    const ingest = await app.inject({ method: "POST", url: path, payload: validPayload });
    expect(ingest.statusCode).toBe(201);

    // The point of the feature: it appears in the *same* list as mail.
    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0]).toMatchObject({ subject: "Review requested", kind: "notification" });
    await app.close();
  });

  it("segments by kind without hiding anything by default", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { path } = await endpointFor(app, identity.sessionToken);
    await app.inject({ method: "POST", url: path, payload: validPayload });

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
    const { path } = await endpointFor(app, identity.sessionToken);
    const payload = { ...validPayload, externalId: "pr-12-review" };

    await app.inject({ method: "POST", url: path, payload });
    await app.inject({ method: "POST", url: path, payload: { ...payload, title: "Review requested (updated)" } });

    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0].subject).toBe("Review requested (updated)");
    await app.close();
  });

  it("accepts an unknown token without revealing that it is unknown", async () => {
    const app = buildApp();
    // 404 here would make the endpoint a token oracle.
    const response = await app.inject({
      method: "POST",
      url: "/notifications/ingest/never-issued-token",
      payload: validPayload,
    });
    expect(response.statusCode).toBe(202);
    await app.close();
  });

  it("never delivers one identity's notification to another", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const { path } = await endpointFor(app, alice.sessionToken);

    await app.inject({ method: "POST", url: path, payload: { ...validPayload, title: "Alice only" } });

    const bobInbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(bob.sessionToken),
    });
    expect(bobInbox.json()).toEqual([]);
    await app.close();
  });

  it("rejects a hostile actionUrl at the ingest boundary", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { path } = await endpointFor(app, identity.sessionToken);

    const response = await app.inject({
      method: "POST",
      url: path,
      payload: { ...validPayload, actionUrl: "javascript:alert(1)" },
    });
    expect(response.statusCode).toBe(400);

    // Nothing was stored — validation happens before the write.
    const inbox = await app.inject({
      method: "GET",
      url: "/identity/messages",
      headers: bearer(identity.sessionToken),
    });
    expect(inbox.json()).toEqual([]);
    await app.close();
  });

  it("rejects a payload missing required fields", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { path } = await endpointFor(app, identity.sessionToken);

    for (const payload of [{}, { app: "GitHub" }, { title: "no app" }]) {
      expect((await app.inject({ method: "POST", url: path, payload })).statusCode).toBe(400);
    }
    await app.close();
  });

  it("bounds an oversized title", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { path } = await endpointFor(app, identity.sessionToken);
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: { ...validPayload, title: "x".repeat(301) },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("is searchable and reachable by the assistant like any other item", async () => {
    const app = buildApp();
    const identity = await register(app);
    const { path } = await endpointFor(app, identity.sessionToken);
    await app.inject({
      method: "POST",
      url: path,
      payload: { app: "Linear", title: "Ticket ENG-42 assigned", body: "deploy pipeline" },
    });

    const search = await app.inject({
      method: "GET",
      url: "/identity/messages?query=ENG-42",
      headers: bearer(identity.sessionToken),
    });
    expect(search.json()).toHaveLength(1);
    await app.close();
  });
});
