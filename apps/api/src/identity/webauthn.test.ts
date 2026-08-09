import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { SoftwareAuthenticator } from "./test-support/software-authenticator.js";

function uniqueUsername(): string {
  return `wa_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function registerPasswordIdentity(app: FastifyInstance) {
  const username = uniqueUsername();
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: { username, password: "correct horse battery staple", wrappedAmkKey: "placeholder-amk-wrap" },
  });
  const session = response.json();
  return { username, sessionToken: session.sessionToken as string };
}

describe("WebAuthn passkey registration", () => {
  it("registers a passkey for an already-logged-in identity", async () => {
    const app = buildApp();
    const { sessionToken } = await registerPasswordIdentity(app);

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/options",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(optionsResponse.statusCode).toBe(200);
    const options = optionsResponse.json();

    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { response: attestation, wrappedAmkKey: "placeholder-passkey-amk-wrap" },
    });

    expect(verifyResponse.statusCode).toBe(201);
    await app.close();
  });

  it("rejects registration without a session", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/identity/webauthn/register/options" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects replaying the same attestation response against a consumed challenge", async () => {
    const app = buildApp();
    const { sessionToken } = await registerPasswordIdentity(app);

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/options",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const options = optionsResponse.json();

    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    const payload = { response: attestation, wrappedAmkKey: "placeholder-passkey-amk-wrap" };
    const first = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload,
    });
    expect(replay.statusCode).toBe(400);

    await app.close();
  });
});

async function registerPasskey(app: FastifyInstance, sessionToken: string) {
  const optionsResponse = await app.inject({
    method: "POST",
    url: "/identity/webauthn/register/options",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const options = optionsResponse.json();

  const authenticator = new SoftwareAuthenticator();
  const attestation = authenticator.register(options.challenge);

  const verifyResponse = await app.inject({
    method: "POST",
    url: "/identity/webauthn/register/verify",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { response: attestation, wrappedAmkKey: "placeholder-passkey-amk-wrap" },
  });
  expect(verifyResponse.statusCode).toBe(201);

  return authenticator;
}

describe("WebAuthn passkey login", () => {
  it("logs in with a registered passkey and the session works", async () => {
    const app = buildApp();
    const { username, sessionToken } = await registerPasswordIdentity(app);
    const authenticator = await registerPasskey(app, sessionToken);

    const loginOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/options",
      payload: { username },
    });
    expect(loginOptionsResponse.statusCode).toBe(200);
    const loginOptions = loginOptionsResponse.json();
    expect(loginOptions.allowCredentials?.length).toBeGreaterThan(0);

    const assertion = authenticator.authenticate(loginOptions.challenge);

    const loginVerifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/verify",
      payload: { username, response: assertion },
    });
    expect(loginVerifyResponse.statusCode).toBe(200);
    const passkeySession = loginVerifyResponse.json();
    expect(passkeySession.username).toBe(username);
    expect(passkeySession.sessionToken).not.toBe(sessionToken);

    const meResponse = await app.inject({
      method: "GET",
      url: "/identity/me",
      headers: { authorization: `Bearer ${passkeySession.sessionToken}` },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().username).toBe(username);

    await app.close();
  });

  it("rejects login options for an unknown username", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/options",
      payload: { username: uniqueUsername() },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a tampered assertion signature", async () => {
    const app = buildApp();
    const { username, sessionToken } = await registerPasswordIdentity(app);
    const authenticator = await registerPasskey(app, sessionToken);

    const loginOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/options",
      payload: { username },
    });
    const loginOptions = loginOptionsResponse.json();
    const assertion = authenticator.authenticate(loginOptions.challenge);

    // Flip the signature so it no longer matches the signed data.
    const tampered = {
      ...assertion,
      response: { ...assertion.response, signature: assertion.response.signature.split("").reverse().join("") },
    };

    const response = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/verify",
      payload: { username, response: tampered },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a replayed challenge (same challenge used twice)", async () => {
    const app = buildApp();
    const { username, sessionToken } = await registerPasswordIdentity(app);
    const authenticator = await registerPasskey(app, sessionToken);

    const loginOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/options",
      payload: { username },
    });
    const loginOptions = loginOptionsResponse.json();
    const assertion = authenticator.authenticate(loginOptions.challenge);

    const first = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/verify",
      payload: { username, response: assertion },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/verify",
      payload: { username, response: assertion },
    });
    expect(replay.statusCode).toBe(401);

    await app.close();
  });
});
