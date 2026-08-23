/**
 * Phase 2 session 5 — the Gmail write adapter.
 *
 * Two operations, both idempotent and both recoverable after an ambiguous
 * timeout:
 *
 * - **Create a reply draft.** The MIME is built server-side and carries a
 *   deterministic `Message-ID` derived from the action's operation key. If
 *   the create times out, the adapter searches for that identifier before
 *   admitting `outcome_unknown` — a draft that was in fact created is found
 *   rather than duplicated on a retry.
 * - **Archive a message.** Provider state is fetched first: a message that
 *   no longer carries `INBOX` is a known idempotent success, not an error.
 *   Otherwise the `INBOX` label is removed and nothing else touched.
 *
 * Tokens, headers, message contents and raw provider responses never appear
 * in logs or in the safe outcome codes this returns.
 */

export type WriteOutcome =
  | { status: "succeeded"; providerId?: string; duplicate?: boolean }
  | { status: "failed"; code: string }
  | { status: "outcome_unknown"; code: string };

export type ReplyDraftInput = {
  to: string;
  subject: string;
  body: string;
  /** The Gmail id of the message being replied to — used to thread the draft. */
  inReplyToProviderMessageId: string;
  operationKey: string;
};

/** Extra fields, resolved from the original message, that make the draft a real reply. */
export type ReplyThreading = {
  /** Gmail thread id, so the draft sits inside the original conversation. */
  threadId?: string;
  /** The original message's RFC822 Message-ID, for In-Reply-To/References. */
  inReplyTo?: string;
};

export interface MailWriteClient {
  createReplyDraft(accessToken: string, input: ReplyDraftInput): Promise<WriteOutcome>;
  archiveMessage(accessToken: string, providerMessageId: string): Promise<WriteOutcome>;
  lookupDraftOutcome(accessToken: string, operationKey: string): Promise<WriteOutcome>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A stable, greppable Message-ID for an operation key — the recovery anchor. */
export function draftMessageId(operationKey: string): string {
  return `<action-${operationKey}@ident.local>`;
}

/**
 * Build the raw RFC 5322 reply, base64url-encoded as Gmail's `raw` field
 * wants. When `threading.inReplyTo` is present it emits `In-Reply-To` and
 * `References` headers pointing at the original message — which, together
 * with the `threadId` set on the draft resource and the `Re:` subject, is
 * what actually makes Gmail file the draft inside the original conversation
 * rather than as a stray new message.
 */
export function buildReplyMime(input: ReplyDraftInput, threading: ReplyThreading = {}): string {
  const headers = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${draftMessageId(input.operationKey)}`,
  ];
  if (threading.inReplyTo) {
    headers.push(`In-Reply-To: ${threading.inReplyTo}`);
    headers.push(`References: ${threading.inReplyTo}`);
  }
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"');
  const raw = `${headers.join("\r\n")}\r\n\r\n${input.body}\r\n`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

type GmailHeader = { name: string; value: string };

export class RealGoogleMailWriteClient implements MailWriteClient {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  async createReplyDraft(accessToken: string, input: ReplyDraftInput): Promise<WriteOutcome> {
    // Resolve threading from the original message before building the draft:
    // its Gmail thread id, and its RFC822 Message-ID for In-Reply-To. A
    // draft is a real reply only if it lands in the original conversation.
    const threading = await this.resolveThreading(accessToken, input.inReplyToProviderMessageId);

    const raw = buildReplyMime(input, threading);
    const body = JSON.stringify({
      message: { raw, ...(threading.threadId ? { threadId: threading.threadId } : {}) },
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${GMAIL_BASE}/drafts`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body,
      });
    } catch {
      // Ambiguous network failure: the draft may or may not exist. Resolve
      // by searching for the deterministic Message-ID rather than retrying
      // blindly, which would risk a duplicate.
      return this.lookupDraftOutcome(accessToken, input.operationKey);
    }

    if (response.ok) {
      const parsed = (await response.json().catch(() => null)) as { id?: string } | null;
      return { status: "succeeded", providerId: parsed?.id };
    }
    return mapHttpFailure(response.status);
  }

  /**
   * Read the original message's thread id and Message-ID header. Best-effort:
   * if it can't be fetched, the draft is still created (unthreaded) rather
   * than the whole action failing over a threading detail.
   */
  private async resolveThreading(
    accessToken: string,
    providerMessageId: string,
  ): Promise<ReplyThreading> {
    try {
      const response = await this.fetchImpl(
        `${GMAIL_BASE}/messages/${providerMessageId}?format=metadata&metadataHeaders=Message-ID`,
        { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) return {};
      const parsed = (await response.json().catch(() => null)) as
        | { threadId?: string; payload?: { headers?: GmailHeader[] } }
        | null;
      const inReplyTo = parsed?.payload?.headers?.find(
        (h) => h.name.toLowerCase() === "message-id",
      )?.value;
      return { threadId: parsed?.threadId, inReplyTo };
    } catch {
      return {};
    }
  }

  async archiveMessage(accessToken: string, providerMessageId: string): Promise<WriteOutcome> {
    let current: Response;
    try {
      current = await this.fetchImpl(
        `${GMAIL_BASE}/messages/${providerMessageId}?format=minimal`,
        { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
      );
    } catch {
      return { status: "outcome_unknown", code: "archive_state_unavailable" };
    }
    if (!current.ok) return mapHttpFailure(current.status);

    const meta = (await current.json().catch(() => null)) as { labelIds?: string[] } | null;
    const labels = meta?.labelIds ?? [];
    // Already archived — a known idempotent success, not a failure.
    if (!labels.includes("INBOX")) return { status: "succeeded", duplicate: true };

    let modified: Response;
    try {
      modified = await this.fetchImpl(`${GMAIL_BASE}/messages/${providerMessageId}/modify`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
      });
    } catch {
      // Timeout: refetch labels to see whether the change actually landed.
      return this.confirmArchived(accessToken, providerMessageId);
    }
    if (modified.ok) return { status: "succeeded" };
    return mapHttpFailure(modified.status);
  }

  private async confirmArchived(accessToken: string, providerMessageId: string): Promise<WriteOutcome> {
    try {
      const check = await this.fetchImpl(
        `${GMAIL_BASE}/messages/${providerMessageId}?format=minimal`,
        { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (!check.ok) return { status: "outcome_unknown", code: "archive_state_unavailable" };
      const meta = (await check.json().catch(() => null)) as { labelIds?: string[] } | null;
      return (meta?.labelIds ?? []).includes("INBOX")
        ? { status: "outcome_unknown", code: "archive_unconfirmed" }
        : { status: "succeeded" };
    } catch {
      return { status: "outcome_unknown", code: "archive_state_unavailable" };
    }
  }

  async lookupDraftOutcome(accessToken: string, operationKey: string): Promise<WriteOutcome> {
    // Gmail search on rfc822msgid finds a draft by its Message-ID.
    const query = encodeURIComponent(`rfc822msgid:${draftMessageId(operationKey)}`);
    try {
      const response = await this.fetchImpl(`${GMAIL_BASE}/messages?q=${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return { status: "outcome_unknown", code: "draft_lookup_failed" };
      const parsed = (await response.json().catch(() => null)) as { messages?: { id: string }[] } | null;
      const found = parsed?.messages?.[0];
      return found
        ? { status: "succeeded", providerId: found.id, duplicate: true }
        : { status: "outcome_unknown", code: "draft_unconfirmed" };
    } catch {
      return { status: "outcome_unknown", code: "draft_lookup_failed" };
    }
  }
}

/** Map an HTTP status to a safe, non-sensitive outcome. */
function mapHttpFailure(status: number): WriteOutcome {
  if (status === 401 || status === 403) return { status: "failed", code: "unauthorized" };
  if (status === 404) return { status: "failed", code: "not_found" };
  if (status === 429) return { status: "failed", code: "rate_limited" };
  if (status >= 500) return { status: "outcome_unknown", code: "provider_error" };
  return { status: "failed", code: "provider_rejected" };
}
