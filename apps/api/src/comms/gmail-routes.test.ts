import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { insertConnectedSource } from "./store.js";

// Deliberately does not exercise the "happy path" of /start or a valid
// /callback here — those would call the real googleOAuthClient singleton
// (no way to inject the fake client through HTTP), which means a real
// network call to Google using real credentials neither this test run nor
// CI has. gmail-service.test.ts covers that behavior directly, with a
// FakeGoogleOAuthClient injected. This file only covers what's reachable
// (and safely testable) purely through the HTTP layer: auth gating,
// input validation, and error paths that never reach Google.
async function registerAndLogin(app: FastifyInstance) {
  const username = `gmail_route_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: { username, password: "correct horse battery staple", wrappedAmkKey: "placeholder-amk-wrap" },
  });
  const session = response.json();
  return { identityId: session.identityId as string, sessionToken: session.sessionToken as string };
}

describe("POST /identity/connections/gmail/start", () => {
  it("rejects a missing session token", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/identity/connections/gmail/start" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /identity/connections/gmail/callback", () => {
  it("redirects with an honest status when Google reports the user declined consent", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/identity/connections/gmail/callback?error=access_denied",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("gmail=denied");
    await app.close();
  });

  it("rejects a callback missing code/state with 400", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/identity/connections/gmail/callback" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("redirects with an error status for an unknown state, without ever reaching Google", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/identity/connections/gmail/callback?code=whatever&state=not-a-real-state",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("gmail=error");
    await app.close();
  });
});

describe("POST /identity/connections/gmail/:sourceId/disconnect", () => {
  it("rejects a missing session token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/identity/connections/gmail/${randomUUID()}/disconnect`,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("404s for an unknown source id", async () => {
    const app = buildApp();
    const { sessionToken } = await registerAndLogin(app);
    const response = await app.inject({
      method: "POST",
      url: `/identity/connections/gmail/${randomUUID()}/disconnect`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("403s when disconnecting a source owned by a different identity", async () => {
    // A tokenless (never-connected) source is enough to test ownership —
    // disconnectGmailSource checks ownership before it ever looks at
    // stored tokens, so this never needs a real Google call.
    const app = buildApp();
    const { identityId: identityA } = await registerAndLogin(app);
    const { sessionToken: sessionB } = await registerAndLogin(app);
    const source = await insertConnectedSource({ identityId: identityA, provider: "gmail" });

    const response = await app.inject({
      method: "POST",
      url: `/identity/connections/gmail/${source.id}/disconnect`,
      headers: { authorization: `Bearer ${sessionB}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("succeeds (204) disconnecting a tokenless source you own, without contacting Google", async () => {
    const app = buildApp();
    const { identityId, sessionToken } = await registerAndLogin(app);
    const source = await insertConnectedSource({ identityId, provider: "gmail" });

    const response = await app.inject({
      method: "POST",
      url: `/identity/connections/gmail/${source.id}/disconnect`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(response.statusCode).toBe(204);
    await app.close();
  });
});
