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
    // Requests PRF capability detection on create() — see webauthn-service's
    // getRegistrationOptions and apps/web/lib/prf.ts for why this is an
    // empty eval (the real secret is pulled by a follow-up get()).
    expect(options.extensions?.prf).toEqual({});

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

  it("stores a per-credential AMK wrap fetchable via GET /identity/amk-wrap?factor=passkey", async () => {
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

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { response: attestation, wrappedAmkKey: "real-prf-derived-ciphertext-blob" },
    });
    expect(verifyResponse.statusCode).toBe(201);

    const wrapResponse = await app.inject({
      method: "GET",
      url: `/identity/amk-wrap?factor=passkey&credentialId=${encodeURIComponent(attestation.id)}`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(wrapResponse.statusCode).toBe(200);
    expect(wrapResponse.json()).toEqual({ factor: "passkey", wrappedKey: "real-prf-derived-ciphertext-blob" });

    await app.close();
  });

  it("won't let one identity read another identity's passkey wrap by credentialId", async () => {
    const app = buildApp();
    const { sessionToken: sessionA } = await registerPasswordIdentity(app);
    const { sessionToken: sessionB } = await registerPasswordIdentity(app);

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/options",
      headers: { authorization: `Bearer ${sessionA}` },
    });
    const options = optionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    await app.inject({
      method: "POST",
      url: "/identity/webauthn/register/verify",
      headers: { authorization: `Bearer ${sessionA}` },
      payload: { response: attestation, wrappedAmkKey: "identity-a-only-blob" },
    });

    const crossResponse = await app.inject({
      method: "GET",
      url: `/identity/amk-wrap?factor=passkey&credentialId=${encodeURIComponent(attestation.id)}`,
      headers: { authorization: `Bearer ${sessionB}` },
    });
    expect(crossResponse.statusCode).toBe(404);

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

describe("Passwordless registration", () => {
  it("creates an identity from only a passkey, with no password", async () => {
    const app = buildApp();
    const username = uniqueUsername();

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    expect(optionsResponse.statusCode).toBe(200);
    const options = optionsResponse.json();
    expect(options.extensions?.prf).toEqual({});

    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/verify",
      payload: { username, response: attestation, wrappedAmkKey: "passwordless-passkey-amk-wrap" },
    });
    expect(verifyResponse.statusCode).toBe(201);
    const result = verifyResponse.json();
    expect(result.username).toBe(username);
    expect(typeof result.sessionToken).toBe("string");
    // A mandatory recovery code — see webauthn-store.ts's
    // createIdentityWithPasskey comment for why a passwordless identity
    // can't be created without one.
    expect(typeof result.recoveryCode).toBe("string");
    expect(result.recoveryCode.length).toBeGreaterThan(10);

    const meResponse = await app.inject({
      method: "GET",
      url: "/identity/me",
      headers: { authorization: `Bearer ${result.sessionToken}` },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().username).toBe(username);

    const passkeyWrapResponse = await app.inject({
      method: "GET",
      url: `/identity/amk-wrap?factor=passkey&credentialId=${encodeURIComponent(attestation.id)}`,
      headers: { authorization: `Bearer ${result.sessionToken}` },
    });
    expect(passkeyWrapResponse.statusCode).toBe(200);
    expect(passkeyWrapResponse.json()).toEqual({
      factor: "passkey",
      wrappedKey: "passwordless-passkey-amk-wrap",
    });

    await app.close();
  });

  it("the returned recovery code can log back in with no passkey or password", async () => {
    const app = buildApp();
    const username = uniqueUsername();

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    const options = optionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/verify",
      payload: { username, response: attestation, wrappedAmkKey: "placeholder" },
    });
    const { recoveryCode } = verifyResponse.json();

    const recoveryLoginResponse = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username, recoveryCode },
    });
    expect(recoveryLoginResponse.statusCode).toBe(200);
    expect(recoveryLoginResponse.json().username).toBe(username);

    await app.close();
  });

  it("does not claim the username if the passkey ceremony is never verified", async () => {
    const app = buildApp();
    const username = uniqueUsername();

    await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    // No verify call — simulates an abandoned ceremony.

    const passwordRegisterResponse = await app.inject({
      method: "POST",
      url: "/identity/register",
      payload: { username, password: "correct horse battery staple", wrappedAmkKey: "blob" },
    });
    expect(passwordRegisterResponse.statusCode).toBe(201);

    await app.close();
  });

  it("rejects a verify for a username whose options were never requested", async () => {
    const app = buildApp();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register("not-a-real-challenge-anyone-issued");

    const response = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/verify",
      payload: { username: uniqueUsername(), response: attestation, wrappedAmkKey: "blob" },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("rejects replaying the same attestation against a consumed challenge", async () => {
    const app = buildApp();
    const username = uniqueUsername();

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    const options = optionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    const payload = { username, response: attestation, wrappedAmkKey: "blob" };
    const first = await app.inject({ method: "POST", url: "/identity/webauthn/register-identity/verify", payload });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({ method: "POST", url: "/identity/webauthn/register-identity/verify", payload });
    expect(replay.statusCode).toBe(400);

    await app.close();
  });

  it("rejects a taken username at verify time", async () => {
    const app = buildApp();
    const username = uniqueUsername();
    await app.inject({
      method: "POST",
      url: "/identity/register",
      payload: { username, password: "correct horse battery staple", wrappedAmkKey: "blob" },
    });

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    const options = optionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/verify",
      payload: { username, response: attestation, wrappedAmkKey: "blob" },
    });
    expect(verifyResponse.statusCode).toBe(409);

    await app.close();
  });

  it("rejects an invalid username at the options step", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username: "AB" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("can log back in via passkey, not just the recovery code", async () => {
    // Regression test: findIdentityByUsername (store.ts) used to inner-join
    // password_credentials, so it silently returned null for any
    // passwordless identity — meaning passkey login (which resolves the
    // username through that same function) failed with "no account with
    // that username" even though the identity, username, and credential
    // all existed. Found via manual browser testing, not by this suite
    // originally, because every other passkey-login test registers a
    // password identity first and adds a passkey second. See store.ts's
    // findIdentityByUsername comment for the fix (left join).
    const app = buildApp();
    const username = uniqueUsername();

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    const options = optionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);

    await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/verify",
      payload: { username, response: attestation, wrappedAmkKey: "blob" },
    });

    const loginOptionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/options",
      payload: { username },
    });
    expect(loginOptionsResponse.statusCode).toBe(200);
    const loginOptions = loginOptionsResponse.json();

    const assertion = authenticator.authenticate(loginOptions.challenge);
    const loginVerifyResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/login/verify",
      payload: { username, response: assertion },
    });
    expect(loginVerifyResponse.statusCode).toBe(200);
    expect(loginVerifyResponse.json().username).toBe(username);

    await app.close();
  });

  it("rejects a password-login attempt against a passwordless identity instead of crashing", async () => {
    const app = buildApp();
    const username = uniqueUsername();

    const optionsResponse = await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/options",
      payload: { username },
    });
    const options = optionsResponse.json();
    const authenticator = new SoftwareAuthenticator();
    const attestation = authenticator.register(options.challenge);
    await app.inject({
      method: "POST",
      url: "/identity/webauthn/register-identity/verify",
      payload: { username, response: attestation, wrappedAmkKey: "blob" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/identity/login",
      payload: { username, password: "irrelevant-this-identity-has-none" },
    });
    expect(response.statusCode).toBe(401);

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
    // Evaluated in this same get() ceremony so login and AMK-unlock cost a
    // single user gesture — see getAuthenticationOptions and lib/prf.ts.
    expect(typeof loginOptions.extensions?.prf?.eval?.first).toBe("string");

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
