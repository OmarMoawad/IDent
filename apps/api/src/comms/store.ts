import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connectedSources, messages } from "../db/schema.js";

export type NewConnectedSource = {
  identityId: string;
  provider: string;
  status?: string;
};

export type ConnectedSource = {
  id: string;
  identityId: string;
  provider: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function insertConnectedSource(input: NewConnectedSource): Promise<ConnectedSource> {
  const [row] = await db
    .insert(connectedSources)
    .values({ identityId: input.identityId, provider: input.provider, status: input.status ?? "pending" })
    .returning({
      id: connectedSources.id,
      identityId: connectedSources.identityId,
      provider: connectedSources.provider,
      status: connectedSources.status,
      createdAt: connectedSources.createdAt,
      updatedAt: connectedSources.updatedAt,
    });
  return row;
}

/**
 * Scoped by identityId, not a global list — one identity can never see
 * another's connected sources, same isolation convention as every other
 * per-identity query in this codebase (e.g. identity/store.ts's AMK wraps).
 */
export async function findConnectedSourcesByIdentity(identityId: string): Promise<ConnectedSource[]> {
  return db
    .select({
      id: connectedSources.id,
      identityId: connectedSources.identityId,
      provider: connectedSources.provider,
      status: connectedSources.status,
      createdAt: connectedSources.createdAt,
      updatedAt: connectedSources.updatedAt,
    })
    .from(connectedSources)
    .where(eq(connectedSources.identityId, identityId));
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
