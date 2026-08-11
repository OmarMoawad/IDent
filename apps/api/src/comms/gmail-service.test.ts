import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  ConnectedSourceNotConnectedError,
  ConnectedSourceNotFoundError,
  ConnectedSourceOwnershipError,
  OauthStateInvalidError,
  completeGmailConnection,
  disconnectGmailSource,
  getActiveGmailAccessToken,
  startGmailConnection,
} from "./gmail-service.js";
import { GoogleOAuthError } from "./google-oauth-client.js";
import { findConnectedSourceEncryptedTokenData, findConnectedSourcesByIdentity } from "./store.js";
import { FakeGoogleOAuthClient } from "./test-support/fake-google-oauth-client.js";
import { decryptTokenPayload } from "./token-encryption.js";

async function createTestIdentity(app: FastifyInstance): Promise<string> {
  const username = `gmail_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: { username, password: "correct horse battery staple", wrappedAmkKey: "placeholder-amk-wrap" },
  });
  return response.json().identityId as string;
}

function extractState(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get("state")!;
}

async function connectSource(app: FastifyInstance, identityId: string, client: FakeGoogleOAuthClient) {
  const { authorizationUrl } = await startGmailConnection(identityId, client);
  const state = extractState(authorizationUrl);
  return completeGmailConnection("fake-auth-code", state, client);
}

describe("gmail-service: startGmailConnection", () => {
  it("returns an authorization URL carrying a fresh, unique state each call", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();

    const first = await startGmailConnection(identityId, client);
    const second = await startGmailConnection(identityId, client);
    expect(extractState(first.authorizationUrl)).not.toBe(extractState(second.authorizationUrl));

    await app.close();
  });
});

describe("gmail-service: completeGmailConnection", () => {
  it("connects a source and encrypts+stores the tokens", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();

    const source = await connectSource(app, identityId, client);
    expect(source.identityId).toBe(identityId);
    expect(source.provider).toBe("gmail");
    expect(source.status).toBe("connected");
    expect(client.exchangeCodeForTokensCalls).toEqual(["fake-auth-code"]);

    const found = await findConnectedSourcesByIdentity(identityId);
    expect(found.map((s) => s.id)).toContain(source.id);

    const encrypted = await findConnectedSourceEncryptedTokenData(source.id);
    expect(encrypted).not.toContain("fake-access-token"); // must be ciphertext, not the raw token
    const payload = JSON.parse(decryptTokenPayload(encrypted!));
    expect(payload.accessToken).toBe("fake-access-token");

    await app.close();
  });

  it("rejects an unknown state without ever calling Google", async () => {
    const client = new FakeGoogleOAuthClient();
    await expect(completeGmailConnection("code", "not-a-real-state", client)).rejects.toThrow(
      OauthStateInvalidError,
    );
    expect(client.exchangeCodeForTokensCalls).toHaveLength(0);
  });

  it("rejects replaying the same state twice", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    const { authorizationUrl } = await startGmailConnection(identityId, client);
    const state = extractState(authorizationUrl);

    await completeGmailConnection("code-1", state, client);
    await expect(completeGmailConnection("code-2", state, client)).rejects.toThrow(OauthStateInvalidError);

    await app.close();
  });

  it("rejects a connection that never receives a refresh token", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    client.nextExchangeResult = {
      accessToken: "access-only",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    };
    const { authorizationUrl } = await startGmailConnection(identityId, client);
    const state = extractState(authorizationUrl);

    await expect(completeGmailConnection("code", state, client)).rejects.toThrow(GoogleOAuthError);

    await app.close();
  });
});

describe("gmail-service: getActiveGmailAccessToken", () => {
  it("returns the stored access token without refreshing when it's not near expiry", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    client.nextExchangeResult = {
      accessToken: "still-valid-token",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: "scope-x",
    };
    const source = await connectSource(app, identityId, client);

    const result = await getActiveGmailAccessToken(identityId, source.id, client);
    expect(result.accessToken).toBe("still-valid-token");
    expect(client.refreshAccessTokenCalls).toHaveLength(0);

    await app.close();
  });

  it("refreshes and persists a new access token when near expiry, and doesn't refresh again right after", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    client.nextExchangeResult = {
      accessToken: "about-to-expire",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 1000), // well inside the refresh buffer
      scope: "scope-x",
    };
    const source = await connectSource(app, identityId, client);
    client.nextRefreshResult = {
      accessToken: "freshly-refreshed",
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: null,
    };

    const result = await getActiveGmailAccessToken(identityId, source.id, client);
    expect(result.accessToken).toBe("freshly-refreshed");
    expect(client.refreshAccessTokenCalls).toEqual(["refresh-1"]);

    const second = await getActiveGmailAccessToken(identityId, source.id, client);
    expect(second.accessToken).toBe("freshly-refreshed");
    expect(client.refreshAccessTokenCalls).toHaveLength(1); // still just the one call

    await app.close();
  });

  it("rotates the stored refresh token when Google issues a new one on refresh", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    client.nextExchangeResult = {
      accessToken: "initial",
      refreshToken: "refresh-original",
      expiresAt: new Date(Date.now() + 1000),
      scope: "scope-x",
    };
    const source = await connectSource(app, identityId, client);
    client.nextRefreshResult = {
      accessToken: "refreshed",
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: "refresh-rotated",
    };

    await getActiveGmailAccessToken(identityId, source.id, client);

    const encrypted = await findConnectedSourceEncryptedTokenData(source.id);
    const payload = JSON.parse(decryptTokenPayload(encrypted!));
    expect(payload.refreshToken).toBe("refresh-rotated");

    await app.close();
  });

  it("rejects reading another identity's connected source", async () => {
    const app = buildApp();
    const identityA = await createTestIdentity(app);
    const identityB = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityA, client);

    await expect(getActiveGmailAccessToken(identityB, source.id, client)).rejects.toThrow(
      ConnectedSourceOwnershipError,
    );

    await app.close();
  });

  it("rejects an unknown source id", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();

    await expect(getActiveGmailAccessToken(identityId, randomUUID(), client)).rejects.toThrow(
      ConnectedSourceNotFoundError,
    );

    await app.close();
  });
});

describe("gmail-service: disconnectGmailSource", () => {
  it("revokes the token with Google and clears stored tokens so a later access-token read fails", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, client);

    await disconnectGmailSource(identityId, source.id, client);

    expect(client.revokeTokenCalls).toHaveLength(1);
    await expect(getActiveGmailAccessToken(identityId, source.id, client)).rejects.toThrow(
      ConnectedSourceNotConnectedError,
    );

    await app.close();
  });

  it("still clears tokens even if Google's revoke call fails", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, client);
    client.revokeToken = async () => {
      throw new GoogleOAuthError("Google unreachable");
    };

    await disconnectGmailSource(identityId, source.id, client);

    await expect(getActiveGmailAccessToken(identityId, source.id, client)).rejects.toThrow(
      ConnectedSourceNotConnectedError,
    );

    await app.close();
  });

  it("rejects disconnecting another identity's source", async () => {
    const app = buildApp();
    const identityA = await createTestIdentity(app);
    const identityB = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityA, client);

    await expect(disconnectGmailSource(identityB, source.id, client)).rejects.toThrow(ConnectedSourceOwnershipError);

    await app.close();
  });

  it("rejects an unknown source id", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeGoogleOAuthClient();

    await expect(disconnectGmailSource(identityId, randomUUID(), client)).rejects.toThrow(
      ConnectedSourceNotFoundError,
    );

    await app.close();
  });
});
