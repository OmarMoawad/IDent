import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  ConnectedSourceNotFoundError,
  ConnectedSourceOwnershipError,
  MissingRefreshTokenError,
  OauthStateInvalidError,
  completeConnection,
  disconnectSource,
  getActiveAccessToken,
  startConnection,
} from "./connection-service.js";
import {
  UnknownConnectorError,
  buildConnectorRegistry,
  gmailConnector,
} from "./connector-registry.js";
import { findConnectedSourceEncryptedTokenData, findConnectedSourcesByIdentity } from "./store.js";
import { FakeOAuthConnectorClient } from "./test-support/fake-oauth-connector.js";
import { decryptTokenPayload } from "./token-encryption.js";

/**
 * Phase 2 session 1 (IDent_STATE.md): the connector abstraction, exercised
 * through a provider that is not Gmail.
 *
 * gmail-service.test.ts still passes unchanged, which shows the refactor
 * broke nothing. It cannot show that the flow is actually generic — it
 * would pass just as well if every Google assumption were still buried in
 * the shared code. This file is the other half of that evidence: the same
 * connect / refresh / disconnect lifecycle, driven by a connector whose
 * account id is an opaque workspace id, whose display label is not an
 * address, and whose endpoints are invented.
 */

const PROVIDER_ID = "fakeworkspace";

function testRegistry(client: FakeOAuthConnectorClient) {
  return buildConnectorRegistry([
    gmailConnector,
    {
      id: PROVIDER_ID,
      displayName: "Fake Workspace",
      feeds: ["messages"],
      fallbackScope: "channels:history",
      client,
    },
  ]);
}

async function createTestIdentity(app: FastifyInstance): Promise<string> {
  const username = `conn_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username,
      password: "correct horse battery staple",
      wrappedAmkKey: "placeholder-amk-wrap",
    },
  });
  return response.json().identityId as string;
}

function extractState(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get("state")!;
}

async function connect(identityId: string, client: FakeOAuthConnectorClient) {
  const registry = testRegistry(client);
  const { authorizationUrl } = await startConnection(identityId, PROVIDER_ID, { registry });
  const state = extractState(authorizationUrl);
  return completeConnection(PROVIDER_ID, "fake-auth-code", state, { registry });
}

describe("connection-service: a provider that is not Gmail", () => {
  it("connects, storing the provider's own id and label separately", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();

    const source = await connect(identityId, client);

    expect(source.provider).toBe(PROVIDER_ID);
    expect(source.status).toBe("connected");
    // The case the Gmail-shaped flow could not represent: an opaque
    // account id that is not an email address, with a human label beside
    // it rather than instead of it.
    expect(source.providerAccountId).toBe("U024BE7LH");
    expect(source.providerAccountEmail).toBe("Acme workspace");

    await app.close();
  });

  it("sends the provider's own authorization URL, not Google's", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();

    const { authorizationUrl } = await startConnection(identityId, PROVIDER_ID, {
      registry: testRegistry(client),
    });
    expect(new URL(authorizationUrl).host).toBe("provider.test");

    await app.close();
  });

  it("stores tokens encrypted, never in the clear", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();

    const source = await connect(identityId, client);
    const encrypted = await findConnectedSourceEncryptedTokenData(source.id);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain("workspace-refresh-token");

    const payload = JSON.parse(decryptTokenPayload(encrypted!));
    expect(payload.refreshToken).toBe("workspace-refresh-token");
    expect(payload.scope).toBe("channels:history users:read");

    await app.close();
  });

  it("reconnecting the same account updates the row instead of adding one", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();

    await connect(identityId, client);
    await connect(identityId, client);

    const sources = await findConnectedSourcesByIdentity(identityId);
    expect(sources.filter((source) => source.provider === PROVIDER_ID)).toHaveLength(1);

    await app.close();
  });

  it("refreshes only once the token is near expiry, and persists what it got", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();
    const registry = testRegistry(client);

    const source = await connect(identityId, client);

    const fresh = await getActiveAccessToken(identityId, source.id, { registry });
    expect(fresh.accessToken).toBe("workspace-access-token");
    expect(client.refreshAccessTokenCalls).toHaveLength(0);

    // Reconnect with an already-expired token so the next read has to
    // refresh. The provider is resolved from the stored row's own
    // `provider` column, which is the part worth proving: nothing in the
    // call passes a provider id.
    client.nextExchangeResult = {
      accessToken: "stale-access-token",
      refreshToken: "workspace-refresh-token",
      expiresAt: new Date(Date.now() - 60_000),
      scope: "channels:history users:read",
    };
    await connect(identityId, client);

    const refreshed = await getActiveAccessToken(identityId, source.id, { registry });
    expect(refreshed.accessToken).toBe("workspace-refreshed-access-token");
    expect(client.refreshAccessTokenCalls).toEqual(["workspace-refresh-token"]);

    const stored = JSON.parse(decryptTokenPayload((await findConnectedSourceEncryptedTokenData(source.id))!));
    expect(stored.accessToken).toBe("workspace-refreshed-access-token");
    // Not rotated on this refresh, so the original must survive.
    expect(stored.refreshToken).toBe("workspace-refresh-token");

    await app.close();
  });

  it("disconnects by revoking and clearing, and will not act for another identity", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const intruderId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();
    const registry = testRegistry(client);

    const source = await connect(identityId, client);

    await expect(disconnectSource(intruderId, source.id, { registry })).rejects.toBeInstanceOf(
      ConnectedSourceOwnershipError,
    );

    await disconnectSource(identityId, source.id, { registry });
    expect(client.revokeTokenCalls).toEqual(["workspace-refresh-token"]);
    expect(await findConnectedSourceEncryptedTokenData(source.id)).toBeNull();

    await app.close();
  });

  it("rejects a state minted for a different provider", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();
    const registry = testRegistry(client);

    const { authorizationUrl } = await startConnection(identityId, PROVIDER_ID, { registry });
    const state = extractState(authorizationUrl);

    // A state challenge is bound to the provider that minted it, so it
    // cannot be redeemed at another connector's callback.
    await expect(
      completeConnection("gmail", "fake-auth-code", state, { registry }),
    ).rejects.toBeInstanceOf(OauthStateInvalidError);

    await app.close();
  });

  it("treats a missing refresh token as a provider-neutral failure", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();
    const registry = testRegistry(client);

    const { authorizationUrl } = await startConnection(identityId, PROVIDER_ID, { registry });
    const state = extractState(authorizationUrl);
    client.nextExchangeResult = {
      accessToken: "workspace-access-token",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scope: "channels:history",
    };

    await expect(
      completeConnection(PROVIDER_ID, "fake-auth-code", state, { registry }),
    ).rejects.toBeInstanceOf(MissingRefreshTokenError);

    await app.close();
  });

  it("refuses an unknown provider rather than writing a row for it", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();

    await expect(
      startConnection(identityId, "notion", { registry: testRegistry(client) }),
    ).rejects.toBeInstanceOf(UnknownConnectorError);

    expect(await findConnectedSourcesByIdentity(identityId)).toHaveLength(0);

    await app.close();
  });

  it("does not find a source that does not exist", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const client = new FakeOAuthConnectorClient();

    await expect(
      getActiveAccessToken(identityId, randomUUID(), { registry: testRegistry(client) }),
    ).rejects.toBeInstanceOf(ConnectedSourceNotFoundError);

    await app.close();
  });
});

describe("connector-registry", () => {
  it("refuses duplicate provider ids", () => {
    const client = new FakeOAuthConnectorClient();
    expect(() =>
      buildConnectorRegistry([
        { id: "dup", displayName: "One", feeds: ["messages"], fallbackScope: "a", client },
        { id: "dup", displayName: "Two", feeds: ["messages"], fallbackScope: "b", client },
      ]),
    ).toThrow(/Duplicate connector id/);
  });

  it("declares Gmail's calendar access, which the connection has always carried", () => {
    // GOOGLE_OAUTH_SCOPES has requested calendar.readonly alongside
    // gmail.readonly since session 15; nothing said so anywhere a reader
    // would look.
    expect(gmailConnector.feeds).toContain("calendar");
  });
});
