import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { ELEVATION_TTL_MS } from "./session.js";
import { SoftwareAuthenticator } from "./test-support/software-authenticator.js";

function uniqueUsername(): string {
  return `elevate_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function registerUser(app: FastifyInstance, password = "correct horse battery staple") {
  const username = uniqueUsername();
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: { username, password, wrappedAmkKey: "placeholder-amk-wrap" },
  });
  const session = response.json();
  return { username, password, sessionToken: session.sessionToken as string };
}

async function getDemoRoute(app: FastifyInstance, sessionToken: string | null) {
  return app.inject({
    method: "GET",
    url: "/identity/demo/high-tier-secret",
    headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Step-up / elevated sessions", () => {
  it("rejects a normal (non-elevated) session from a High/Critical-tier route", async () => {
    const app = buildApp();
    const { sessionToken } = await registerUser(app);

    const response = await getDemoRoute(app, sessionToken);
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("rejects a missing or invalid session token before even checking elevation", async () => {
    const app = buildApp();

    const missing = await getDemoRoute(app, null);
    expect(missing.statusCode).toBe(401);

    const invalid = await getDemoRoute(app, "not-a-real-token");
    expect(invalid.statusCode).toBe(401);

    await app.close();
  });

  it("elevates via the password factor and unlocks the demo route", async () => {
    const app = buildApp();
    const { username, password, sessionToken } = await registerUser(app);

    const elevateResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/password",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { password },
    });
    expect(elevateResponse.statusCode).toBe(200);
    expect(typeof elevateResponse.json().elevatedUntil).toBe("string");

    const demoResponse = await getDemoRoute(app, sessionToken);
    expect(demoResponse.statusCode).toBe(200);
    const body = demoResponse.json();
    expect(typeof body.secret).toBe("string");
    expect(typeof body.identityId).toBe("string");

    const meResponse = await app.inject({
      method: "GET",
      url: "/identity/me",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(meResponse.json().username).toBe(username);
    expect(typeof meResponse.json().elevatedUntil).toBe("string");

    await app.close();
  });

  it("rejects the wrong password and leaves the session un-elevated", async () => {
    const app = buildApp();
    const { sessionToken } = await registerUser(app);

    const elevateResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/password",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { password: "definitely-wrong" },
    });
    expect(elevateResponse.statusCode).toBe(401);

    const demoResponse = await getDemoRoute(app, sessionToken);
    expect(demoResponse.statusCode).toBe(403);

    await app.close();
  });

  it("elevates via the recovery-code factor and unlocks the demo route", async () => {
    const app = buildApp();
    const { sessionToken } = await registerUser(app);

    const generateResponse = await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const { recoveryCode } = generateResponse.json();

    const elevateResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/recovery",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { recoveryCode },
    });
    expect(elevateResponse.statusCode).toBe(200);

    const demoResponse = await getDemoRoute(app, sessionToken);
    expect(demoResponse.statusCode).toBe(200);

    await app.close();
  });

  it("rejects the wrong recovery code and leaves the session un-elevated", async () => {
    const app = buildApp();
    const { sessionToken } = await registerUser(app);
    await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    const elevateResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/recovery",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { recoveryCode: "WRONG-WRONG-WRONG-WRONG" },
    });
    expect(elevateResponse.statusCode).toBe(401);

    const demoResponse = await getDemoRoute(app, sessionToken);
    expect(demoResponse.statusCode).toBe(403);

    await app.close();
  });

  it("elevates via a passkey assertion and unlocks the demo route", async () => {
    const app = buildApp();
    const { sessionToken } = await registerUser(app);

    const registerOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/options",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const registerOptions = registerOptionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(registerOptions.challenge);
    await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { response: attestation, wrappedAmkKey: "placeholder-passkey-amk-wrap" },
    });

    const elevateOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/webauthn/options",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(elevateOptionsResponse.statusCode).toBe(200);
    const elevateOptions = elevateOptionsResponse.json();
    const assertion = authenticator.authenticate(elevateOptions.challenge);

    const elevateVerifyResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/webauthn/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { response: assertion },
    });
    expect(elevateVerifyResponse.statusCode).toBe(200);

    const demoResponse = await getDemoRoute(app, sessionToken);
    expect(demoResponse.statusCode).toBe(200);

    await app.close();
  });

  it("rejects a tampered passkey assertion during elevation", async () => {
    const app = buildApp();
    const { sessionToken } = await registerUser(app);

    const registerOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/options",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const registerOptions = registerOptionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(registerOptions.challenge);
    await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { response: attestation, wrappedAmkKey: "placeholder-passkey-amk-wrap" },
    });

    const elevateOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/webauthn/options",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const elevateOptions = elevateOptionsResponse.json();
    const assertion = authenticator.authenticate(elevateOptions.challenge);
    const tampered = {
      ...assertion,
      response: { ...assertion.response, signature: assertion.response.signature.split("").reverse().join("") },
    };

    const elevateVerifyResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/webauthn/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { response: tampered },
    });
    expect(elevateVerifyResponse.statusCode).toBe(401);

    const demoResponse = await getDemoRoute(app, sessionToken);
    expect(demoResponse.statusCode).toBe(403);

    await app.close();
  });

  it("rejects an expired elevation instead of treating it as still elevated", async () => {
    const app = buildApp();
    const { password, sessionToken } = await registerUser(app);

    const elevateResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/password",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { password },
    });
    expect(elevateResponse.statusCode).toBe(200);

    // Confirm it actually works before expiry, then jump the clock past
    // ELEVATION_TTL_MS — proves this is a real expiry check against
    // sessions.elevatedUntil, not a static/one-shot flag.
    expect((await getDemoRoute(app, sessionToken)).statusCode).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ELEVATION_TTL_MS + 1000);

    const expiredResponse = await getDemoRoute(app, sessionToken);
    expect(expiredResponse.statusCode).toBe(403);

    await app.close();
  });

  it("cannot elevate a session that has already been logged out", async () => {
    const app = buildApp();
    const { password, sessionToken } = await registerUser(app);

    await app.inject({
      method: "POST",
      url: "/identity/logout",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    const elevateResponse = await app.inject({
      method: "POST",
      url: "/identity/elevate/password",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { password },
    });
    expect(elevateResponse.statusCode).toBe(401);

    await app.close();
  });
});
