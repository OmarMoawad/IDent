// The seam gmail-sync-service.ts calls through to fetch actual message
// content from Gmail — separate from google-oauth-client.ts's
// GoogleOAuthClient, which only ever handles the OAuth token lifecycle
// (connect/refresh/revoke), never message content. Same reasoning as that
// interface: comms/test-support/fake-gmail-api-client.ts stands in during
// tests, so no session ever needs a real Google account or real network
// access to exercise the sync logic itself.
export type GmailMessage = {
  id: string;
  snippet: string;
  // Gmail's own internalDate: epoch milliseconds, as a string.
  internalDate: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  bodyText: string | null;
};

export interface GmailApiClient {
  /** Most-recent-first, per Gmail's own default list ordering. */
  listMessageIds(accessToken: string, maxResults: number): Promise<string[]>;
  getMessage(accessToken: string, id: string): Promise<GmailMessage>;
}

export class GmailApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailApiError";
  }
}

const MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
export type GmailMessageResource = {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    body?: { data?: string };
    mimeType?: string;
    parts?: GmailPart[];
  };
};

function findHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

// Gmail base64url-encodes part bodies (RFC 4648 §5) — Node's "base64url"
// buffer encoding decodes that directly, no manual +/- swapping needed.
function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/**
 * Depth-first search for the first text/plain part — the same "prefer
 * plain text over HTML" default a plain-text-first mail client would use.
 * Recurses into multipart/alternative and multipart/mixed containers,
 * which is how Gmail nests a plain+HTML pair or an attachment alongside
 * the message body.
 */
function findPlainTextBody(part: GmailPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = findPlainTextBody(child);
    if (found) return found;
  }
  return null;
}

/**
 * The pure Gmail-response-shape → GmailMessage transform — exported
 * specifically so it's directly unit-testable (MIME traversal, base64url
 * decoding, missing-field handling) without mocking `fetch`, the same
 * "only test the pure part directly" convention google-oauth-client.
 * test.ts already documents for RealGoogleOAuthClient.getAuthorizationUrl
 * (network-calling methods there are exercised indirectly instead,
 * through the fake client double).
 */
export function toGmailMessage(resource: GmailMessageResource): GmailMessage {
  const headers = resource.payload?.headers;
  const bodyText =
    resource.payload?.mimeType === "text/plain" && resource.payload.body?.data
      ? decodeBase64Url(resource.payload.body.data)
      : findPlainTextBody(resource.payload as GmailPart | undefined);

  return {
    id: resource.id,
    snippet: resource.snippet ?? "",
    internalDate: resource.internalDate ?? String(Date.now()),
    subject: findHeader(headers, "Subject"),
    from: findHeader(headers, "From"),
    to: findHeader(headers, "To"),
    bodyText,
  };
}

export class RealGmailApiClient implements GmailApiClient {
  async listMessageIds(accessToken: string, maxResults: number): Promise<string[]> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    const response = await fetch(`${MESSAGES_ENDPOINT}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => null)) as { messages?: { id: string }[] } | null;
    if (!response.ok) {
      throw new GmailApiError("Could not list Gmail messages.");
    }
    return (body?.messages ?? []).map((m) => m.id);
  }

  async getMessage(accessToken: string, id: string): Promise<GmailMessage> {
    const params = new URLSearchParams({ format: "full" });
    const response = await fetch(`${MESSAGES_ENDPOINT}/${id}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => null)) as GmailMessageResource | null;
    if (!response.ok || !body) {
      throw new GmailApiError(`Could not fetch Gmail message ${id}.`);
    }
    return toGmailMessage(body);
  }
}

export const gmailApiClient: GmailApiClient = new RealGmailApiClient();
