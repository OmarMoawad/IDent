import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { contacts } from "../db/schema.js";

export type Contact = {
  id: string;
  identityId: string;
  address: string;
  displayName: string | null;
  messageCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  updatedAt: Date;
};

export type DerivedContact = {
  address: string;
  displayName: string | null;
  messageCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

const contactColumns = {
  id: contacts.id,
  identityId: contacts.identityId,
  address: contacts.address,
  displayName: contacts.displayName,
  messageCount: contacts.messageCount,
  firstSeenAt: contacts.firstSeenAt,
  lastSeenAt: contacts.lastSeenAt,
  updatedAt: contacts.updatedAt,
};

const MAX_CONTACTS = 500;

/**
 * Replaces an identity's derived contact rows with a freshly computed set,
 * in one transaction so a reader never observes a half-rebuilt contact
 * list. Delete-then-insert rather than a diff: the whole set is derived
 * from `messages` anyway (see contacts-service.ts), so computing a minimal
 * diff would add real complexity to save writes on a table that only holds
 * a few hundred rows per identity.
 *
 * Scoped by identityId on both the delete and the insert — a rebuild for
 * one identity can never touch another's rows.
 */
export async function replaceContactsForIdentity(identityId: string, derived: DerivedContact[]): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(contacts).where(eq(contacts.identityId, identityId));
    if (derived.length === 0) return 0;
    const rows = derived.slice(0, MAX_CONTACTS).map((contact) => ({ identityId, ...contact }));
    await tx.insert(contacts).values(rows);
    return rows.length;
  });
}

/**
 * Identity-scoped, most-recently-seen first — the order a contact list is
 * actually read in, and the order contacts_identity_last_seen_idx serves
 * directly. Search matches either the display name or the address, the
 * same case-insensitive contains-match the inbox search uses.
 */
export async function findContactsByIdentity(
  identityId: string,
  options: { query?: string; limit?: number } = {},
): Promise<Contact[]> {
  const query = options.query?.trim();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  const search = query
    ? or(ilike(contacts.displayName, `%${query}%`), ilike(contacts.address, `%${query}%`))
    : undefined;
  return db
    .select(contactColumns)
    .from(contacts)
    .where(search ? and(eq(contacts.identityId, identityId), search) : eq(contacts.identityId, identityId))
    .orderBy(desc(contacts.lastSeenAt))
    .limit(limit);
}

/**
 * Defensive ownership re-check, same convention as comms/store.ts's
 * findMessageByIdForIdentity: one identity must not be able to read
 * another's contact by guessing an id.
 */
export async function findContactByIdForIdentity(id: string, identityId: string): Promise<Contact | null> {
  const rows = await db
    .select(contactColumns)
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.identityId, identityId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countContactsForIdentity(identityId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(eq(contacts.identityId, identityId));
  return rows[0]?.count ?? 0;
}
