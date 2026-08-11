import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

function uniqueUsername(): string {
  return `test_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

type RegisterOverrides = Partial<{ username: string; password: string; wrappedAmkKey: string }>;

async function registerUser(app: FastifyInstance, overrides: RegisterOverrides = {}) {
  const body = {
    username: overrides.username ?? uniqueUsername(),
    password: overrides.password ?? "correct horse battery staple",
    wrappedAmkKey: overrides.wrappedAmkKey ?? "base64-opaque-ciphertext-placeholder",
  };
  const response = await app.inject({ method: "POST", url: "/identity/register", payload: body });
  return { response, body };
}

describe("POST /identity/register", () => {
  it("creates an identity and returns a session", async () => {
    const app = buildApp();
    const { response, body } = await registerUser(app);

    expect(response.statusCode).toBe(201);
    const session = response.json();
    expect(session.username).toBe(body.username);
    expect(typeof session.identityId).toBe("string");
    expect(typeof session.sessionToken).toBe("string");
    expect(session.sessionToken.length).toBeGreaterThan(20);

    await app.close();
  });

  it("rejects a duplicate username", async () => {
    const app = buildApp();
    const username = uniqueUsername();
    await registerUser(app, { username });
    const { response } = await registerUser(app, { username });

    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("rejects an invalid username", async () => {
    const app = buildApp();
    const { response } = await registerUser(app, { username: "AB" });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a weak password", async () => {
    const app = buildApp();
    const { response } = await registerUser(app, { password: "short" });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /identity/login", () => {
  it("logs in with correct credentials and issues a new session", async () => {
    const app = buildApp();
    const password = "correct horse battery staple";
    const { body: registerBody } = await registerUser(app, { password });

    const response = await app.inject({
      method: "POST",
      url: "/identity/login",
      payload: { username: registerBody.username, password },
    });

    expect(response.statusCode).toBe(200);
    const session = response.json();
    expect(session.username).toBe(registerBody.username);
    expect(typeof session.sessionToken).toBe("string");

    await app.close();
  });

  it("rejects a wrong password", async () => {
    const app = buildApp();
    const { body: registerBody } = await registerUser(app);

    const response = await app.inject({
      method: "POST",
      url: "/identity/login",
      payload: { username: registerBody.username, password: "definitely-wrong" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a username that doesn't exist", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/identity/login",
      payload: { username: uniqueUsername(), password: "irrelevant-password" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /identity/me", () => {
  it("returns the identity for a valid session token", async () => {
    const app = buildApp();
    const { response: registerResponse, body } = await registerUser(app);
    const { sessionToken, identityId } = registerResponse.json();

    const response = await app.inject({
      method: "GET",
      url: "/identity/me",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ identityId, username: body.username, elevatedUntil: null });

    await app.close();
  });

  it("rejects a missing session token", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/identity/me" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an invalid session token", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/identity/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("POST /identity/logout", () => {
  it("revokes the session so it can no longer authenticate", async () => {
    const app = buildApp();
    const { response: registerResponse } = await registerUser(app);
    const { sessionToken } = registerResponse.json();

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/identity/logout",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(logoutResponse.statusCode).toBe(204);

    const meResponse = await app.inject({
      method: "GET",
      url: "/identity/me",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(meResponse.statusCode).toBe(401);

    await app.close();
  });
});

describe("POST /identity/recovery/generate + PUT /identity/recovery/wrap", () => {
  it("generates a code, accepts a wrap for it, and the code then logs in", async () => {
    const app = buildApp();
    const { response: registerResponse, body } = await registerUser(app);
    const { sessionToken } = registerResponse.json();

    const generateResponse = await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(generateResponse.statusCode).toBe(201);
    const { recoveryCode } = generateResponse.json();
    expect(typeof recoveryCode).toBe("string");
    expect(recoveryCode.length).toBeGreaterThan(10);

    const wrapResponse = await app.inject({
      method: "PUT",
      url: "/identity/recovery/wrap",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { wrappedAmkKey: "recovery-wrapped-amk-blob" },
    });
    expect(wrapResponse.statusCode).toBe(204);

    const loginResponse = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username: body.username, recoveryCode },
    });
    expect(loginResponse.statusCode).toBe(200);
    const session = loginResponse.json();
    expect(session.username).toBe(body.username);

    const amkWrapResponse = await app.inject({
      method: "GET",
      url: "/identity/amk-wrap?factor=recovery",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(amkWrapResponse.statusCode).toBe(200);
    expect(amkWrapResponse.json()).toEqual({ factor: "recovery", wrappedKey: "recovery-wrapped-amk-blob" });

    await app.close();
  });

  it("rejects generate/wrap without a session", async () => {
    const app = buildApp();
    const generateResponse = await app.inject({ method: "POST", url: "/identity/recovery/generate" });
    expect(generateResponse.statusCode).toBe(401);

    const wrapResponse = await app.inject({
      method: "PUT",
      url: "/identity/recovery/wrap",
      payload: { wrappedAmkKey: "irrelevant" },
    });
    expect(wrapResponse.statusCode).toBe(401);

    await app.close();
  });

  it("regenerating invalidates the previous code", async () => {
    const app = buildApp();
    const { response: registerResponse, body } = await registerUser(app);
    const { sessionToken } = registerResponse.json();

    const first = await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const { recoveryCode: firstCode } = first.json();

    await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    const loginWithOldCode = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username: body.username, recoveryCode: firstCode },
    });
    expect(loginWithOldCode.statusCode).toBe(401);

    await app.close();
  });
});

describe("POST /identity/recovery/login", () => {
  it("rejects a wrong recovery code", async () => {
    const app = buildApp();
    const { response: registerResponse, body } = await registerUser(app);
    const { sessionToken } = registerResponse.json();
    await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    const response = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username: body.username, recoveryCode: "WRONG-WRONG-WRONG-WRONG" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a username that never generated a recovery code", async () => {
    const app = buildApp();
    const { body } = await registerUser(app);

    const response = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username: body.username, recoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a username that doesn't exist", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username: uniqueUsername(), recoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("accepts the code with or without hyphens and regardless of case", async () => {
    const app = buildApp();
    const { response: registerResponse, body } = await registerUser(app);
    const { sessionToken } = registerResponse.json();
    const generateResponse = await app.inject({
      method: "POST",
      url: "/identity/recovery/generate",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const { recoveryCode } = generateResponse.json();

    const response = await app.inject({
      method: "POST",
      url: "/identity/recovery/login",
      payload: { username: body.username, recoveryCode: recoveryCode.replace(/-/g, "").toLowerCase() },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /identity/amk-wrap", () => {
  it("returns the wrap stored at registration, defaulting to the password factor", async () => {
    const app = buildApp();
    const { response: registerResponse } = await registerUser(app, {
      wrappedAmkKey: "the-exact-blob-sent-at-registration",
    });
    const { sessionToken } = registerResponse.json();

    const response = await app.inject({
      method: "GET",
      url: "/identity/amk-wrap",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ factor: "password", wrappedKey: "the-exact-blob-sent-at-registration" });

    await app.close();
  });

  it("rejects a missing session token", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/identity/amk-wrap" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("404s for a password-factor identity that never registered one (defensive: shouldn't be reachable in practice)", async () => {
    const app = buildApp();
    const { response: registerResponse } = await registerUser(app);
    const { sessionToken } = registerResponse.json();

    const response = await app.inject({
      method: "GET",
      url: "/identity/amk-wrap?factor=something-unrecognized",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects factor=passkey without a credentialId", async () => {
    const app = buildApp();
    const { response: registerResponse } = await registerUser(app);
    const { sessionToken } = registerResponse.json();

    const response = await app.inject({
      method: "GET",
      url: "/identity/amk-wrap?factor=passkey",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for factor=passkey with a credentialId that isn't registered", async () => {
    const app = buildApp();
    const { response: registerResponse } = await registerUser(app);
    const { sessionToken } = registerResponse.json();

    const response = await app.inject({
      method: "GET",
      url: "/identity/amk-wrap?factor=passkey&credentialId=not-a-real-credential",
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
