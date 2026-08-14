import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { insertConnectedSource, upsertMessage } from "./store.js";

async function register(app: FastifyInstance) {
  const response = await app.inject({ method: "POST", url: "/identity/register", payload: { username: `inbox_${randomUUID().replace(/-/g, "").slice(0, 16)}`, password: "correct horse battery staple", wrappedAmkKey: "wrap" } });
  return response.json() as { identityId: string; sessionToken: string };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Communications Hub read routes", () => {
  it("requires authentication for sources, list, and detail", async () => {
    const app = buildApp();
    for (const url of ["/identity/connections", "/identity/messages", `/identity/messages/${randomUUID()}`]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    await app.close();
  });

  it("returns sanitized sources and searchable normalized messages", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail", status: "connected", providerAccountId: "private-stable-id", providerAccountEmail: "user@example.com" });
    await upsertMessage({ identityId: identity.identityId, sourceId: source.id, externalId: "message-1", subject: "Project Atlas", occurredAt: new Date("2026-08-13T10:00:00Z") });

    const sources = (await app.inject({ method: "GET", url: "/identity/connections", headers: bearer(identity.sessionToken) })).json();
    expect(Object.keys(sources[0]).sort()).toEqual(["createdAt", "id", "provider", "providerAccountEmail", "status", "updatedAt"]);

    const list = await app.inject({ method: "GET", url: "/identity/messages?query=atlas", headers: bearer(identity.sessionToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).toMatchObject({ subject: "Project Atlas", source: { provider: "gmail", providerAccountEmail: "user@example.com" } });
    await app.close();
  });

  it("bounds search input and makes cross-tenant detail indistinguishable from missing", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const source = await insertConnectedSource({ identityId: alice.identityId, provider: "gmail" });
    const message = await upsertMessage({ identityId: alice.identityId, sourceId: source.id, externalId: "private", body: "private body", occurredAt: new Date() });
    expect((await app.inject({ method: "GET", url: `/identity/messages?query=${"x".repeat(201)}`, headers: bearer(alice.sessionToken) })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/identity/messages/${message.id}`, headers: bearer(bob.sessionToken) })).statusCode).toBe(404);
    const owned = await app.inject({ method: "GET", url: `/identity/messages/${message.id}`, headers: bearer(alice.sessionToken) });
    expect(owned.statusCode).toBe(200);
    expect(owned.json().body).toBe("private body");
    await app.close();
  });
});
