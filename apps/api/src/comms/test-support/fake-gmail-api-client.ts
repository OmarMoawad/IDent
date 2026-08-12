import type { GmailApiClient, GmailMessage } from "../gmail-api-client.js";

/**
 * A programmable stand-in for Gmail's real messages.list/messages.get
 * endpoints — same role FakeGoogleOAuthClient plays for the OAuth token
 * lifecycle: lets gmail-sync-service.ts's tests exercise real sync/
 * normalization logic without a real Gmail account or real network access.
 * Seed `messages` with whatever a test wants "in the mailbox"; listMessageIds
 * returns their ids in the same order (most-recent-first, matching Gmail's
 * own default), capped at maxResults.
 */
export class FakeGmailApiClient implements GmailApiClient {
  messages: GmailMessage[] = [];
  listMessageIdsCalls: number[] = [];
  getMessageCalls: string[] = [];

  async listMessageIds(_accessToken: string, maxResults: number): Promise<string[]> {
    this.listMessageIdsCalls.push(maxResults);
    return this.messages.slice(0, maxResults).map((m) => m.id);
  }

  async getMessage(_accessToken: string, id: string): Promise<GmailMessage> {
    this.getMessageCalls.push(id);
    const found = this.messages.find((m) => m.id === id);
    if (!found) throw new Error(`FakeGmailApiClient: no seeded message with id ${id}`);
    return found;
  }
}

/** A minimal, realistic GmailMessage for tests that don't care about specifics. */
export function fakeGmailMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: overrides.id ?? "fake-message-id",
    snippet: overrides.snippet ?? "Fake snippet text",
    internalDate: overrides.internalDate ?? String(Date.now()),
    subject: overrides.subject ?? "Fake subject",
    from: overrides.from ?? "Sender Name <sender@example.com>",
    to: overrides.to ?? "Recipient Name <recipient@example.com>",
    bodyText: overrides.bodyText ?? "Fake body text.",
  };
}
