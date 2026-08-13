import { and, asc, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { connectedSources, messages, oauthStateChallenges } from "../db/schema.js";

export type NewConnectedSource = {
  identityId: string;
  provider: string;
  status?: string;
  providerAccountId?: string;
  providerAccountEmail?: string;
};

export type ConnectedSource = {
  id: string;
  identityId: string;
  provider: string;
  status: string;
  providerAccountId: string | null;
  providerAccountEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const connectedSourceColumns = {
  id: connectedSources.id,
  identityId: connectedSources.identityId,
  provider: connectedSources.provider,
  status: connectedSources.status,
  providerAccountId: connectedSources.providerAccountId,
  providerAccountEmail: connectedSources.providerAccountEmail,
  createdAt: connectedSources.createdAt,
  updatedAt: connectedSources.updatedAt,
};

export async function insertConnectedSource(input: NewConnectedSource): Promise<ConnectedSource> {
  const [row] = await db
    .insert(connectedSources)
    .values({
      identityId: input.identityId,
      provider: input.provider,
      status: input.status ?? "pending",
      providerAccountId: input.providerAccountId,
      providerAccountEmail: input.providerAccountEmail,
    })
    .returning(connectedSourceColumns);
  return row;
}

/**
 * Scoped by identityId, not a global list — one identity can never see
 * another's connected sources, same isolation convention as every other
 * per-identity query in this codebase (e.g. identity/store.ts's AMK wraps).
 */
export async function findConnectedSourcesByIdentity(identityId: string): Promise<ConnectedSource[]> {
  return db.select(connectedSourceColumns).from(connectedSources).where(eq(connectedSources.identityId, identityId));
}

/**
 * Looks up an existing connection to the same real-world provider account
 * (see connected_sources_identity_provider_account_key in schema.ts) so
 * reconnecting the same Gmail mailbox updates that row instead of
 * creating a redundant duplicate — see gmail-service.ts's
 * completeGmailConnection.
 */
/**
 * Atomic get-or-create, keyed on the same
 * (identityId, provider, providerAccountId) uniqueness the schema already
 * declares. `insertConnectedSource` plus a prior lookup is a read-then-write
 * race: two concurrent first-time deliveries both see nothing and both
 * insert. That race is not theoretical for the notification pseudo-source,
 * where the two requests arrive from the same third-party service at once.
 *
 * Requires a **non-null** providerAccountId — Postgres treats NULLs as
 * distinct in a UNIQUE constraint, so a null here would let duplicates
 * through even with the conflict target set.
 */
export async function getOrCreateConnectedSource(input: {
  identityId: string;
  provider: string;
  providerAccountId: string;
  status?: string;
}): Promise<ConnectedSource> {
  const [row] = await db
    .insert(connectedSources)
    .values({
      identityId: input.identityId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      status: input.status ?? "connected",
    })
    .onConflictDoUpdate({
      target: [connectedSources.identityId, connectedSources.provider, connectedSources.providerAccountId],
      // A no-op update rather than DoNothing: DoNothing returns no row on
      // conflict, which would leave the loser of the race with nothing.
      set: { updatedAt: new Date() },
    })
    .returning(connectedSourceColumns);
  return row;
}

export async function findConnectedSourceByProviderAccount(
  identityId: string,
  provider: string,
  providerAccountId: string,
): Promise<ConnectedSource | null> {
  const rows = await db
    .select(connectedSourceColumns)
    .from(connectedSources)
    .where(
      and(
        eq(connectedSources.identityId, identityId),
        eq(connectedSources.provider, provider),
        eq(connectedSources.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const messageColumns = {
  id: messages.id,
  identityId: messages.identityId,
  sourceId: messages.sourceId,
  externalId: messages.externalId,
  subject: messages.subject,
  snippet: messages.snippet,
  body: messages.body,
  participants: messages.participants,
  occurredAt: messages.occurredAt,
  isRead: messages.isRead,
  kind: messages.kind,
  actionUrl: messages.actionUrl,
  createdAt: messages.createdAt,
};

export type NewMessage = {
  identityId: string;
  sourceId: string;
  externalId: string;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  participants?: string;
  occurredAt: Date;
  isRead?: boolean;
  /** "message" (default) | "notification" — see the schema comment. */
  kind?: string;
  actionUrl?: string | null;
};

export type Message = {
  id: string;
  identityId: string;
  sourceId: string;
  externalId: string;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  participants: string | null;
  occurredAt: Date;
  isRead: boolean;
  kind: string;
  actionUrl: string | null;
  createdAt: Date;
};

/**
 * Upserts on (sourceId, externalId) — see messages_source_external_id_idx
 * in schema.ts — so re-syncing the same connected source is idempotent
 * instead of creating duplicate rows every sync run. Re-syncing an
 * already-known message refreshes its content fields (a provider can edit
 * a draft, correct a subject, etc.) but deliberately leaves isRead alone:
 * a sync shouldn't silently re-mark something the user already read as
 * unread again, or vice versa.
 */
export async function upsertMessage(input: NewMessage): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      identityId: input.identityId,
      sourceId: input.sourceId,
      externalId: input.externalId,
      subject: input.subject,
      snippet: input.snippet,
      body: input.body,
      participants: input.participants,
      occurredAt: input.occurredAt,
      isRead: input.isRead ?? false,
      kind: input.kind ?? "message",
      actionUrl: input.actionUrl ?? null,
    })
    .onConflictDoUpdate({
      target: [messages.sourceId, messages.externalId],
      set: {
        subject: input.subject,
        snippet: input.snippet,
        body: input.body,
        participants: input.participants,
        occurredAt: input.occurredAt,
        kind: input.kind ?? "message",
        actionUrl: input.actionUrl ?? null,
      },
    })
    .returning(messageColumns);
  return row;
}

/**
 * Scoped by identityId (denormalized onto messages — see schema.ts's
 * comment on why) so this is a single indexed lookup, not a join through
 * connected_sources. Ordered newest-first, since "what came in" is the
 * natural default read order for an inbox.
 */
export async function findMessagesByIdentity(
  identityId: string,
  options: { query?: string; limit?: number; kind?: string } = {},
): Promise<Message[]> {
  const query = options.query?.trim();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  const search = query
    ? or(
        ilike(messages.subject, `%${query}%`),
        ilike(messages.snippet, `%${query}%`),
        ilike(messages.body, `%${query}%`),
        ilike(messages.participants, `%${query}%`),
      )
    : undefined;
  // The unified inbox lists both kinds by default — that is the whole
  // point of it. `kind` narrows to one segment when the user asks.
  const filters = [eq(messages.identityId, identityId)];
  if (search) filters.push(search);
  if (options.kind) filters.push(eq(messages.kind, options.kind));

  return db
    .select(messageColumns)
    .from(messages)
    .where(and(...filters))
    .orderBy(desc(messages.occurredAt))
    .limit(limit);
}

/**
 * Defensive ownership re-check, same convention as identity/webauthn-
 * service.ts's getPasskeyAmkWrap: verifies the message actually belongs to
 * the calling identity before returning it, so one identity can't read
 * another's message by guessing/enumerating a message id.
 */
export async function findMessageByIdForIdentity(id: string, identityId: string): Promise<Message | null> {
  const rows = await db
    .select(messageColumns)
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.identityId, identityId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findConnectedSourceById(id: string): Promise<ConnectedSource | null> {
  const rows = await db.select(connectedSourceColumns).from(connectedSources).where(eq(connectedSources.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The one place comms/store.ts hands back the raw encrypted blob —
 * ConnectedSource's own shape (returned everywhere else) deliberately
 * omits it. Only comms/gmail-service.ts should call this, to decrypt and
 * use the tokens; never surface this value from an HTTP route.
 */
export async function findConnectedSourceEncryptedTokenData(sourceId: string): Promise<string | null> {
  const rows = await db
    .select({ encryptedTokenData: connectedSources.encryptedTokenData })
    .from(connectedSources)
    .where(eq(connectedSources.id, sourceId))
    .limit(1);
  return rows[0]?.encryptedTokenData ?? null;
}

/**
 * Stores the (already-encrypted — see token-encryption.ts) token payload
 * for a connected source and marks it connected. The caller is
 * responsible for encrypting; this function never sees plaintext tokens.
 */
export async function setConnectedSourceTokens(sourceId: string, encryptedTokenData: string): Promise<void> {
  await db
    .update(connectedSources)
    .set({ encryptedTokenData, status: "connected", updatedAt: new Date() })
    .where(eq(connectedSources.id, sourceId));
}

/**
 * Disconnects a source by clearing its token material outright, not just
 * flipping a status label — IDent_STATE.md's session-2 checklist calls
 * for a disconnect that actually stops future syncs from touching it, and
 * "no tokens stored" is a guarantee no future sync code path can
 * accidentally ignore the way a status check could be forgotten.
 */
export async function clearConnectedSourceTokens(sourceId: string): Promise<void> {
  await db
    .update(connectedSources)
    .set({ encryptedTokenData: null, status: "disconnected", updatedAt: new Date() })
    .where(eq(connectedSources.id, sourceId));
}

export async function insertOauthStateChallenge(input: {
  identityId: string;
  provider: string;
  state: string;
  pkceVerifier: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(oauthStateChallenges).values(input);
}

export type ConsumedOauthState = {
  identityId: string;
  provider: string;
  pkceVerifier: string;
};

/**
 * Atomically resolves and consumes an OAuth state value — the *only*
 * correlating information the callback request carries (see this table's
 * comment in schema.ts). Consumed exactly once, whether or not the rest of
 * the callback succeeds, so a state value can never be replayed. Mirrors
 * identity/webauthn-store.ts's consumeChallenge shape (select the pending
 * row, then an update guarded by the same not-yet-consumed condition, so
 * two near-simultaneous requests for the same state can't both "win").
 */
export async function consumeOauthStateChallenge(state: string): Promise<ConsumedOauthState | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: oauthStateChallenges.id,
        identityId: oauthStateChallenges.identityId,
        provider: oauthStateChallenges.provider,
        pkceVerifier: oauthStateChallenges.pkceVerifier,
      })
      .from(oauthStateChallenges)
      .where(
        and(
          eq(oauthStateChallenges.state, state),
          isNull(oauthStateChallenges.consumedAt),
          gt(oauthStateChallenges.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const pending = rows[0];
    if (!pending) return null;

    const updated = await tx
      .update(oauthStateChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthStateChallenges.id, pending.id), isNull(oauthStateChallenges.consumedAt)))
      .returning({ id: oauthStateChallenges.id });

    if (updated.length === 0) return null; // lost the race to a concurrent consume

    return { identityId: pending.identityId, provider: pending.provider, pkceVerifier: pending.pkceVerifier };
  });
}

const CLASSIFY_BATCH_SIZE = 500;
/** Matches contacts-store.ts's ceiling; see the note there. */
const MAX_CLASSIFY_MESSAGES = 50_000;

/**
 * Every message for an identity, oldest-first, for whole-mailbox passes.
 *
 * Deliberately separate from findMessagesByIdentity, which caps at 100 for
 * the inbox read path. Importance classification used that capped query
 * and therefore silently ignored everything older than the newest 100 —
 * the same mistake contact derivation made and had to be corrected for.
 * Keyset-batched on (occurredAt, id) so it is stable under concurrent
 * inserts.
 */
export async function findAllMessagesByIdentity(identityId: string): Promise<Message[]> {
  const rows: Message[] = [];
  let cursor: { occurredAt: Date; id: string } | null = null;

  while (rows.length < MAX_CLASSIFY_MESSAGES) {
    const page: Message[] = await db
      .select(messageColumns)
      .from(messages)
      .where(
        cursor
          ? and(
              eq(messages.identityId, identityId),
              sql`(${messages.occurredAt}, ${messages.id}) > (${cursor.occurredAt}, ${cursor.id})`,
            )
          : eq(messages.identityId, identityId),
      )
      .orderBy(asc(messages.occurredAt), asc(messages.id))
      .limit(CLASSIFY_BATCH_SIZE);

    if (page.length === 0) break;
    rows.push(...page);
    if (page.length < CLASSIFY_BATCH_SIZE) break;
    const last = page[page.length - 1];
    cursor = { occurredAt: last.occurredAt, id: last.id };
  }

  return rows;
}
