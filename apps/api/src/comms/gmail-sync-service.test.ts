import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { GMAIL_SYNC_MAX_MESSAGES } from "./comms-config.js";
import { completeGmailConnection, startGmailConnection } from "./gmail-service.js";
import { syncGmailMessages } from "./gmail-sync-service.js";
import { FakeGoogleOAuthClient } from "./test-support/fake-google-oauth-client.js";
import { FakeGmailApiClient, fakeGmailMessage } from "./test-support/fake-gmail-api-client.js";
import { findMessagesByIdentity } from "./store.js";

async function createTestIdentity(app: FastifyInstance): Promise<string> {
  const username = `gmail_sync_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
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

async function connectSource(app: FastifyInstance, identityId: string, oauthClient: FakeGoogleOAuthClient) {
  const { authorizationUrl } = await startGmailConnection(identityId, oauthClient);
  const state = extractState(authorizationUrl);
  return completeGmailConnection("fake-auth-code", state, oauthClient);
}

describe("gmail-sync-service: syncGmailMessages", () => {
  it("pulls messages from the fake mailbox and stores them normalized in the messages table", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const oauthClient = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, oauthClient);

    const apiClient = new FakeGmailApiClient();
    apiClient.messages = [
      fakeGmailMessage({
        id: "msg-1",
        subject: "Welcome",
        snippet: "Hi there",
        from: "Alice Sender <alice@example.com>",
        to: "Bob Recipient <bob@example.com>",
        bodyText: "Hello, this is the body.",
        internalDate: "1700000000000",
      }),
      fakeGmailMessage({ id: "msg-2", subject: "Second message", internalDate: "1700000100000" }),
    ];

    const result = await syncGmailMessages(identityId, source.id, oauthClient, apiClient);
    expect(result).toEqual({ sourceId: source.id, messagesSeen: 2, messagesUpserted: 2 });

    const stored = await findMessagesByIdentity(identityId);
    expect(stored).toHaveLength(2);
    const welcome = stored.find((m) => m.externalId === "msg-1")!;
    expect(welcome.subject).toBe("Welcome");
    expect(welcome.snippet).toBe("Hi there");
    expect(welcome.body).toBe("Hello, this is the body.");
    expect(welcome.occurredAt.getTime()).toBe(1700000000000);
    const participants = JSON.parse(welcome.participants!);
    expect(participants.from).toEqual([{ name: "Alice Sender", address: "alice@example.com" }]);
    expect(participants.to).toEqual([{ name: "Bob Recipient", address: "bob@example.com" }]);

    await app.close();
  });

  it("re-syncing the same source updates content instead of duplicating rows", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const oauthClient = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, oauthClient);

    const apiClient = new FakeGmailApiClient();
    apiClient.messages = [fakeGmailMessage({ id: "msg-1", subject: "Original subject" })];
    await syncGmailMessages(identityId, source.id, oauthClient, apiClient);

    apiClient.messages = [fakeGmailMessage({ id: "msg-1", subject: "Edited subject" })];
    await syncGmailMessages(identityId, source.id, oauthClient, apiClient);

    const stored = await findMessagesByIdentity(identityId);
    expect(stored.filter((m) => m.externalId === "msg-1")).toHaveLength(1);
    expect(stored.find((m) => m.externalId === "msg-1")!.subject).toBe("Edited subject");

    await app.close();
  });

  it("caps how many messages a single sync fetches at GMAIL_SYNC_MAX_MESSAGES", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const oauthClient = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, oauthClient);

    const apiClient = new FakeGmailApiClient();
    apiClient.messages = Array.from({ length: GMAIL_SYNC_MAX_MESSAGES + 10 }, (_, i) =>
      fakeGmailMessage({ id: `msg-${i}` }),
    );

    const result = await syncGmailMessages(identityId, source.id, oauthClient, apiClient);
    expect(result.messagesSeen).toBe(GMAIL_SYNC_MAX_MESSAGES);
    expect(apiClient.getMessageCalls).toHaveLength(GMAIL_SYNC_MAX_MESSAGES);

    await app.close();
  });

  it("a message with no display name in From/To still stores an address-only participant", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const oauthClient = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, oauthClient);

    const apiClient = new FakeGmailApiClient();
    apiClient.messages = [fakeGmailMessage({ id: "msg-1", from: "plain@example.com", to: "also-plain@example.com" })];
    await syncGmailMessages(identityId, source.id, oauthClient, apiClient);

    const stored = await findMessagesByIdentity(identityId);
    const participants = JSON.parse(stored[0].participants!);
    expect(participants.from).toEqual([{ address: "plain@example.com" }]);
    expect(participants.to).toEqual([{ address: "also-plain@example.com" }]);

    await app.close();
  });

  it("a malformed internalDate falls back to now instead of aborting the whole sync", async () => {
    const app = buildApp();
    const identityId = await createTestIdentity(app);
    const oauthClient = new FakeGoogleOAuthClient();
    const source = await connectSource(app, identityId, oauthClient);

    const apiClient = new FakeGmailApiClient();
    apiClient.messages = [
      fakeGmailMessage({ id: "msg-good-before", internalDate: "1700000000000" }),
      fakeGmailMessage({ id: "msg-bad", internalDate: "not-a-timestamp" }),
      fakeGmailMessage({ id: "msg-good-after", internalDate: "1700000200000" }),
    ];

    const before = Date.now();
    const result = await syncGmailMessages(identityId, source.id, oauthClient, apiClient);
    const after = Date.now();

    expect(result).toEqual({ sourceId: source.id, messagesSeen: 3, messagesUpserted: 3 });
    const stored = await findMessagesByIdentity(identityId);
    expect(stored.map((m) => m.externalId).sort()).toEqual(["msg-bad", "msg-good-after", "msg-good-before"]);

    const bad = stored.find((m) => m.externalId === "msg-bad")!;
    expect(bad.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(bad.occurredAt.getTime()).toBeLessThanOrEqual(after);

    // The message after the malformed one still got upserted too — proves
    // the fallback keeps the loop going rather than the whole sync call
    // throwing partway through.
    expect(stored.find((m) => m.externalId === "msg-good-after")).toBeTruthy();

    await app.close();
  });
});
