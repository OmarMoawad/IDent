import { and, desc, eq, isNull, gt } from "drizzle-orm";
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

export type NewMessage = {
  identityId: string;
  sourceId: string;
  externalId: string;
  subject?: string;
  snippet?: string;
  body?: string;
  participants?: string;
  occurredAt: Date;
  isRead?: boolean;
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
    })
    .onConflictDoUpdate({
      target: [messages.sourceId, messages.externalId],
      set: {
        subject: input.subject,
        snippet: input.snippet,
        body: input.body,
        participants: input.participants,
        occurredAt: input.occurredAt,
      },
    })
    .returning({
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
      createdAt: messages.createdAt,
    });
  return row;
}

/**
 * Scoped by identityId (denormalized onto messages — see schema.ts's
 * comment on why) so this is a single indexed lookup, not a join through
 * connected_sources. Ordered newest-first, since "what came in" is the
 * natural default read order for an inbox.
 */
export async function findMessagesByIdentity(identityId: string): Promise<Message[]> {
  return db
    .select({
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
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.identityId, identityId))
    .orderBy(desc(messages.occurredAt));
}

/**
 * Defensive ownership re-check, same convention as identity/webauthn-
 * service.ts's getPasskeyAmkWrap: verifies the message actually belongs to
 * the calling identity before returning it, so one identity can't read
 * another's message by guessing/enumerating a message id.
 */
export async function findMessageByIdForIdentity(id: string, identityId: string): Promise<Message | null> {
  const rows = await db
    .select({
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
      createdAt: messages.createdAt,
    })
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
