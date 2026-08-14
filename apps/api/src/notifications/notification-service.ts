import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notificationEndpoints } from "../db/schema.js";
import { getOrCreateConnectedSource, upsertMessage } from "../comms/store.js";

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
 * The ingest token is a bearer credential, so only its **hash** is stored —
 * the same rule the `sessions` table applies to its cookie. A database dump
 * therefore yields nothing usable, and the plaintext exists only in the one
 * response that mints it.
 *
 * The consequence, deliberately accepted: a lost token cannot be shown
 * again, only replaced. That is how an API key should behave.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const NOTIFICATION_TOKEN_HEADER = "x-ident-notification-token";

/**
 * Mints a new token, replacing any existing one. Rotation *is* revocation:
 * the previous hash is overwritten, so a leaked token stops working the
 * moment this is called.
 *
 * 144 bits of entropy — the token is the entire credential on the ingest
 * path, and brute-force must be hopeless rather than merely expensive.
 */
export async function rotateNotificationToken(identityId: string): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  await db
    .insert(notificationEndpoints)
    .values({ identityId, tokenHash: hashToken(token) })
    .onConflictDoUpdate({
      target: notificationEndpoints.identityId,
      set: { tokenHash: hashToken(token), lastError: null, lastErrorAt: null },
    });
  return token;
}

export type EndpointStatus = { configured: boolean; createdAt: Date | null; lastError: string | null; lastErrorAt: Date | null };

/**
 * Status only — never the token. The plaintext is unrecoverable by design;
 * `lastError` is how the owner debugs a misconfigured sender given that the
 * ingest endpoint deliberately tells the sender nothing (see the routes).
 */
export async function getNotificationEndpointStatus(identityId: string): Promise<EndpointStatus> {
  const rows = await db
    .select({
      createdAt: notificationEndpoints.createdAt,
      lastError: notificationEndpoints.lastError,
      lastErrorAt: notificationEndpoints.lastErrorAt,
    })
    .from(notificationEndpoints)
    .where(eq(notificationEndpoints.identityId, identityId))
    .limit(1);
  const row = rows[0];
  return {
    configured: Boolean(row),
    createdAt: row?.createdAt ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
  };
}

async function resolveIdentity(token: string): Promise<string | null> {
  const rows = await db
    .select({ identityId: notificationEndpoints.identityId })
    .from(notificationEndpoints)
    // Compared by hash, so the plaintext is never in a query either.
    .where(eq(notificationEndpoints.tokenHash, hashToken(token)))
    .limit(1);
  return rows[0]?.identityId ?? null;
}

/**
 * Recorded so the owner can see why a sender was rejected, given that the
 * sender itself is told nothing.
 */
async function recordDeliveryError(identityId: string, message: string): Promise<void> {
  await db
    .update(notificationEndpoints)
    .set({ lastError: message.slice(0, 500), lastErrorAt: new Date() })
    .where(eq(notificationEndpoints.identityId, identityId));
}

/**
 * Recording the error must not itself become a way to fail differently for
 * a live token — if the database is the thing that broke, this write is
 * broken too. Swallowed deliberately; the route still logs the original.
 */
async function tryRecordDeliveryError(identityId: string, message: string): Promise<void> {
  try {
    await recordDeliveryError(identityId, message);
  } catch {
    // Intentionally empty: see above.
  }
}

/**
 * Notifications need a connected source because `messages` is tied to one
 * by composite foreign key. Rather than weaken that constraint — it is
 * what stops a row belonging to one identity while pointing at another's
 * source — each identity gets one pseudo-source the first time it
 * receives a notification.
 */
async function notificationSourceId(identityId: string): Promise<string> {
  // Atomic, and with a **non-null** providerAccountId so the existing
  // (identityId, provider, providerAccountId) uniqueness actually applies:
  // Postgres treats NULLs as distinct, so the previous find-then-insert let
  // two concurrent first deliveries each create a pseudo-source.
  const source = await getOrCreateConnectedSource({
    identityId,
    provider: NOTIFICATION_PROVIDER,
    providerAccountId: NOTIFICATION_PROVIDER,
    status: "connected",
  });
  return source.id;
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
  return stripNulBytes(parsed.toString());
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

/**
 * Every outcome is `accepted` from the caller's point of view. See
 * ingestNotification for why.
 *
 * `internalError` is for the *operator*, never the caller: the route logs
 * it and still sends the same body. It rides on the result rather than
 * being thrown so that "this function does not throw" is a property of the
 * type, not a promise the next edit can quietly break.
 */
export type IngestResult = { status: "accepted"; messageId?: string; internalError?: unknown };

/**
 * Postgres cannot store a NUL byte in a `text` column — it rejects the
 * parameter as an invalid UTF-8 byte sequence. That made an unremarkable
 * string a database error rather than a validation error, which is how it
 * became a live-token oracle (see ingestNotification). Handled as what it
 * is: malformed input from the sender, refused here and recorded for the
 * owner, rather than a fault reported as ours.
 */
const NUL_BYTE = "\u0000";

function stripNulBytes(value: string): string {
  // Split/join rather than a /g regex: a global regex carries lastIndex
  // between calls, so sharing one with a .test() below would make the
  // check alternate true/false on identical input.
  return value.split(NUL_BYTE).join("");
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidNotificationError(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InvalidNotificationError(`${field} must be ${max} characters or fewer.`);
  if (trimmed.includes(NUL_BYTE)) throw new InvalidNotificationError(`${field} must not contain NUL bytes.`);
  return trimmed;
}

/**
 * Ingest one notification. **Never signals to the caller whether the token
 * was real.**
 *
 * An earlier version returned 202 for an unknown token and 201/400 for a
 * known one, which was described as non-diagnostic and wasn't: a malformed
 * payload distinguished a live token from a dead one in a single request.
 * A 144-bit token makes discovery by enumeration hopeless either way, but
 * the distinction still let someone holding a *leaked* token confirm it was
 * live, so the claim was wrong and the behaviour is now what the claim
 * said. Rejections are recorded against the endpoint instead, where the
 * owner — and only the owner — can read them.
 *
 * Objective 0 review (2026-08-14) asked whether any way to tell the two
 * apart survived. One did, and it was reachable: only
 * `InvalidNotificationError` was handled and every other throw became a
 * 500, which only a live token could reach, since a dead one returns
 * before any write. A NUL byte in `title` was enough — it passes every
 * length and type check here, and Postgres then rejects it as an invalid
 * UTF-8 byte sequence, so `{app, title: "x\u0000y"}` answered 500 for a
 * live token and 202 for a dead one. Verified against the real database,
 * not reasoned about.
 *
 * Closed twice over: NUL bytes are now rejected as invalid input, and the
 * catch-all below means no future fallible write can reopen the oracle in
 * silence. The one distinguisher that remains is **timing** — a dead token
 * costs one indexed lookup, a live one several writes — which is not
 * closed here, and is written down in IDent_STATE.md rather than claimed
 * away.
 */
export async function ingestNotification(token: string, input: NotificationInput): Promise<IngestResult> {
  const identityId = await resolveIdentity(token);
  if (!identityId) return { status: "accepted" };

  try {
    const app = requireString(input.app, "app", MAX_APP_LENGTH);
    const title = requireString(input.title, "title", MAX_TITLE_LENGTH);
    const body = typeof input.body === "string" ? stripNulBytes(input.body.trim()).slice(0, MAX_BODY_LENGTH) : null;
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
        ? stripNulBytes(`${app}:${input.externalId.trim()}`).slice(0, 300)
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
      participants: JSON.stringify({
        from: [{ name: app, address: `${app.toLowerCase()}@notifications.ident` }],
        to: [],
      }),
      occurredAt,
      kind: "notification",
      actionUrl,
    });

    return { status: "accepted", messageId: message.id };
  } catch (error) {
    if (error instanceof InvalidNotificationError) {
      await tryRecordDeliveryError(identityId, error.message);
      return { status: "accepted" };
    }
    // Anything else is a fault on our side, not the sender's. The owner is
    // told that a delivery failed, in terms that describe nothing about the
    // internals; the operator gets the real error through the route's log.
    await tryRecordDeliveryError(identityId, "An internal error prevented this delivery from being stored.");
    return { status: "accepted", internalError: error };
  }
}
