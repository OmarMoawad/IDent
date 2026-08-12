import { GMAIL_SYNC_MAX_MESSAGES } from "./comms-config.js";
import { gmailApiClient, type GmailApiClient } from "./gmail-api-client.js";
import { getActiveGmailAccessToken } from "./gmail-service.js";
import { type GoogleOAuthClient, googleOAuthClient } from "./google-oauth-client.js";
import { parseParticipants } from "./participants.js";
import { upsertMessage } from "./store.js";

export type SyncGmailMessagesResult = {
  sourceId: string;
  messagesSeen: number;
  messagesUpserted: number;
};

/**
 * Pulls the most recent GMAIL_SYNC_MAX_MESSAGES messages from a connected
 * Gmail source and normalizes them into the shared `messages` table.
 * On-demand, not a background poller — a single call does one list + up to
 * GMAIL_SYNC_MAX_MESSAGES gets, per IDent_STATE.md's session-14.5 note that
 * on-demand was the simpler design to start Phase 1's message sync with;
 * a scheduled/background sync is a later session if this proves too manual.
 *
 * Ownership and connection-state checks (unknown source, another identity's
 * source, a disconnected source) all come from getActiveGmailAccessToken —
 * the same function connect/refresh already goes through — so this
 * function never needs to duplicate that logic, and a caller only ever
 * sees ConnectedSourceNotFoundError / ConnectedSourceOwnershipError /
 * ConnectedSourceNotConnectedError, the same three gmail-service.ts already
 * exports and gmail-routes.ts already knows how to map to HTTP statuses.
 */
export async function syncGmailMessages(
  identityId: string,
  sourceId: string,
  oauthClient: GoogleOAuthClient = googleOAuthClient,
  apiClient: GmailApiClient = gmailApiClient,
): Promise<SyncGmailMessagesResult> {
  const { accessToken } = await getActiveGmailAccessToken(identityId, sourceId, oauthClient);

  const ids = await apiClient.listMessageIds(accessToken, GMAIL_SYNC_MAX_MESSAGES);

  for (const id of ids) {
    const gmailMessage = await apiClient.getMessage(accessToken, id);
    await upsertMessage({
      identityId,
      sourceId,
      externalId: gmailMessage.id,
      subject: gmailMessage.subject ?? undefined,
      snippet: gmailMessage.snippet,
      body: gmailMessage.bodyText ?? undefined,
      participants: JSON.stringify({
        from: parseParticipants(gmailMessage.from),
        to: parseParticipants(gmailMessage.to),
      }),
      occurredAt: new Date(Number(gmailMessage.internalDate)),
    });
  }

  return { sourceId, messagesSeen: ids.length, messagesUpserted: ids.length };
}
