import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notificationEndpoints } from "../db/schema.js";
import { findConnectedSourcesByIdentity, insertConnectedSource, upsertMessage } from "../comms/store.js";

/**
 * Phase 1 session 20 — notification aggregation.
 *
 * ROADMAP.md's Phase 1 opens with "Unified inbox: messages **and
 * notifications** pulled from connected sources", and its exit criteria
 * names a "notification/inbox aggregator". The eight-session cadence
 * shipped every numbered item without ever shipping notifications, so the
 * cadence read complete while the phase's own first bullet did not.
 *
 * Notifications land in the same `messages` table as mail, discriminated
 * by `kind` — see the schema comment for why one table rather than two.
 */

const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4_000;
const MAX_APP_LENGTH = 100;
/** The provider name of the pseudo-source every notification hangs off. */
export const NOTIFICATION_PROVIDER = "notifications";

export class InvalidNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNotificationError";
  }
}

/**
 * Stable per identity: an endpoint the user has already configured in a
 * third-party service must not change underneath them, so this upserts
 * rather than regenerating. 144 bits of entropy, base64url — the token is
 * the only credential on the ingest path.
 */
export async function getOrCreateNotificationToken(identityId: string): Promise<string> {
  const existing = await db
    .select({ token: notificationEndpoints.token })
    .from(notificationEndpoints)
    .where(eq(notificationEndpoints.identityId, identityId))
    .limit(1);
  if (existing[0]) return existing[0].token;

  const [row] = await db
    .insert(notificationEndpoints)
    .values({ identityId, token: randomBytes(18).toString("base64url") })
    .onConflictDoNothing()
    .returning({ token: notificationEndpoints.token });

  // Lost a race with a concurrent create — read the winner rather than
  // handing back a token that was never stored.
  if (row) return row.token;
  const winner = await db
    .select({ token: notificationEndpoints.token })
    .from(notificationEndpoints)
    .where(eq(notificationEndpoints.identityId, identityId))
    .limit(1);
  return winner[0].token;
}

async function resolveIdentity(token: string): Promise<string | null> {
  const rows = await db
    .select({ identityId: notificationEndpoints.identityId })
    .from(notificationEndpoints)
    .where(eq(notificationEndpoints.token, token))
    .limit(1);
  return rows[0]?.identityId ?? null;
}

/**
 * Notifications need a connected source because `messages` is tied to one
 * by composite foreign key. Rather than weaken that constraint — it is
 * what stops a row belonging to one identity while pointing at another's
 * source — each identity gets one pseudo-source the first time it
 * receives a notification.
 */
async function notificationSourceId(identityId: string): Promise<string> {
  const sources = await findConnectedSourcesByIdentity(identityId);
  const existing = sources.find((source) => source.provider === NOTIFICATION_PROVIDER);
  if (existing) return existing.id;

  const created = await insertConnectedSource({
    identityId,
    provider: NOTIFICATION_PROVIDER,
    status: "connected",
  });
  return created.id;
}

/**
 * Only http and https may be rendered as a link. `javascript:` (and
 * `data:`) in an href is stored XSS, and this value arrives from outside
 * the system — validated on write so a bad URL can never reach the
 * database, rather than relying on every future reader to re-check.
 */
export function safeActionUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new InvalidNotificationError("actionUrl must be a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidNotificationError("actionUrl must be http or https.");
  }
  return parsed.toString();
}

export type NotificationInput = {
  /** The service that sent it, e.g. "GitHub". Shown as the source label. */
  app?: unknown;
  title?: unknown;
  body?: unknown;
  actionUrl?: unknown;
  /** The sender's own id, used for idempotency. */
  externalId?: unknown;
  occurredAt?: unknown;
};

export type IngestResult = { status: "accepted"; messageId: string } | { status: "unknown-endpoint" };

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidNotificationError(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InvalidNotificationError(`${field} must be ${max} characters or fewer.`);
  return trimmed;
}

export async function ingestNotification(token: string, input: NotificationInput): Promise<IngestResult> {
  const identityId = await resolveIdentity(token);
  // Validation happens only after the token resolves, so a caller with a
  // bad token learns nothing about which payloads would have been valid.
  if (!identityId) return { status: "unknown-endpoint" };

  const app = requireString(input.app, "app", MAX_APP_LENGTH);
  const title = requireString(input.title, "title", MAX_TITLE_LENGTH);
  const body = typeof input.body === "string" ? input.body.trim().slice(0, MAX_BODY_LENGTH) : null;
  const actionUrl = safeActionUrl(input.actionUrl);

  const occurredAt = typeof input.occurredAt === "string" ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new InvalidNotificationError("occurredAt must be a valid date.");
  }

  // A sender that supplies its own id gets idempotency for free (the
  // upsert is on (sourceId, externalId)); one that doesn't gets a fresh
  // row per delivery, which is the honest behaviour — we cannot
  // deduplicate what we cannot identify.
  const externalId =
    typeof input.externalId === "string" && input.externalId.trim()
      ? `${app}:${input.externalId.trim()}`.slice(0, 300)
      : `${app}:${randomBytes(12).toString("base64url")}`;

  const message = await upsertMessage({
    identityId,
    sourceId: await notificationSourceId(identityId),
    externalId,
    subject: title,
    snippet: body?.slice(0, 200) ?? null,
    body,
    // Reuses the shared participants envelope so the sender renders the
    // same way a message sender does, and the assistant's existing
    // retrieval reads it without a special case.
    participants: JSON.stringify({ from: [{ name: app, address: `${app.toLowerCase()}@notifications.ident` }], to: [] }),
    occurredAt,
    kind: "notification",
    actionUrl,
  });

  return { status: "accepted", messageId: message.id };
}
