import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { contacts, messages } from "../db/schema.js";

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

/** The minimum a message contributes to contact derivation. */
export type ParticipantRow = { participants: string | null; occurredAt: Date };

const DERIVATION_BATCH_SIZE = 1_000;
/**
 * Safety ceiling so one enormous mailbox can't turn a rebuild into an
 * unbounded memory load. Far above any realistic per-identity message
 * count today; if it is ever hit, derivation should move into SQL
 * aggregation rather than this ceiling being raised.
 */
const MAX_DERIVATION_MESSAGES = 50_000;

/**
 * Every message for an identity, oldest-first, selecting only the two
 * columns derivation needs.
 *
 * Deliberately *not* findMessagesByIdentity: that one is the inbox read
 * path and caps at 100 rows. Deriving contacts from a 100-row window and
 * then replacing the whole contact set (see replaceContactsForIdentity)
 * silently dropped everyone who only appears in older mail, and made
 * messageCount/firstSeenAt drift every time the window advanced. Contacts
 * are a claim about the whole mailbox, so the query behind them has to
 * see the whole mailbox.
 *
 * Batched by keyset on (occurredAt, id) rather than OFFSET: stable under
 * concurrent inserts, and doesn't re-scan skipped rows on every page.
 */
export async function findAllParticipantRowsForIdentity(identityId: string): Promise<ParticipantRow[]> {
  const rows: ParticipantRow[] = [];
  let cursor: { occurredAt: Date; id: string } | null = null;

  while (rows.length < MAX_DERIVATION_MESSAGES) {
    const page: Array<{ id: string; participants: string | null; occurredAt: Date }> = await db
      .select({ id: messages.id, participants: messages.participants, occurredAt: messages.occurredAt })
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
      .limit(DERIVATION_BATCH_SIZE);

    if (page.length === 0) break;
    for (const row of page) rows.push({ participants: row.participants, occurredAt: row.occurredAt });
    if (page.length < DERIVATION_BATCH_SIZE) break;
    const last = page[page.length - 1];
    cursor = { occurredAt: last.occurredAt, id: last.id };
  }

  return rows;
}

export type ContactMessage = {
  id: string;
  subject: string | null;
  snippet: string | null;
  occurredAt: Date;
  isRead: boolean;
  participants: string | null;
};

/**
 * Recent messages involving one address, filtered in the database rather
 * than by post-filtering a global newest-100 window — which returned
 * nothing at all for a contact whose mail is older than the 100 most
 * recent messages overall.
 *
 * The `ILIKE` is a *prefilter* on the JSON blob, not the authority: it can
 * match an address appearing as a substring of a longer one, so the caller
 * still confirms an exact participant match (see contacts-routes.ts). A
 * generous multiplier on the limit leaves room for the caller to discard
 * those near-misses and still fill the page.
 */
export async function findMessagesForParticipant(
  identityId: string,
  address: string,
  limit: number,
): Promise<ContactMessage[]> {
  return db
    .select({
      id: messages.id,
      subject: messages.subject,
      snippet: messages.snippet,
      occurredAt: messages.occurredAt,
      isRead: messages.isRead,
      participants: messages.participants,
    })
    .from(messages)
    .where(and(eq(messages.identityId, identityId), ilike(messages.participants, `%${address}%`)))
    .orderBy(desc(messages.occurredAt))
    .limit(Math.min(limit * 5, 200));
}

export async function countContactsForIdentity(identityId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(eq(contacts.identityId, identityId));
  return rows[0]?.count ?? 0;
}
