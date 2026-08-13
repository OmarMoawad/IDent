import { parseMessageParticipants, participantKey, type Participant } from "@ident/shared";
import { findConnectedSourcesByIdentity, findMessagesByIdentity } from "./store.js";
import { replaceContactsForIdentity, type DerivedContact } from "./contacts-store.js";

/**
 * Phase 1 session 17 — Contact cards.
 *
 * Turns an identity's messages into one record per person. Pure derivation
 * (see the `contacts` table comment in schema.ts): this can be re-run at
 * any time and always produces the same result from the same messages, so
 * it is safe to call after every sync without tracking incremental state.
 */

/** Every participant on a message, sender and recipients alike. */
function allParticipants(raw: string | null): Participant[] {
  const { from, to } = parseMessageParticipants(raw);
  return [...from, ...to];
}

type Accumulator = {
  address: string;
  displayName: string | null;
  displayNameSeenAt: Date | null;
  messageCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

/**
 * The identity's own mailbox addresses, which must not become contacts —
 * you are not your own contact, and every single message would otherwise
 * produce a top-ranked "contact" that is just you. Taken from the
 * connected sources' own `providerAccountEmail`, i.e. the address IDent
 * verified at OAuth time, rather than guessed from message headers.
 */
function ownAddresses(sources: Array<{ providerAccountEmail: string | null }>): Set<string> {
  const own = new Set<string>();
  for (const source of sources) {
    if (source.providerAccountEmail) own.add(participantKey(source.providerAccountEmail));
  }
  return own;
}

export function deriveContacts(
  messages: Array<{ participants: string | null; occurredAt: Date }>,
  excludedAddresses: Set<string> = new Set(),
): DerivedContact[] {
  const byAddress = new Map<string, Accumulator>();

  for (const message of messages) {
    // One person appearing twice on the same message (as sender and
    // recipient, or listed twice) is still one interaction, not two.
    const seenOnThisMessage = new Set<string>();

    for (const participant of allParticipants(message.participants)) {
      const key = participantKey(participant.address);
      if (!key || excludedAddresses.has(key)) continue;
      if (seenOnThisMessage.has(key)) continue;
      seenOnThisMessage.add(key);

      const name = participant.name?.trim() || null;
      const existing = byAddress.get(key);
      if (!existing) {
        byAddress.set(key, {
          address: key,
          displayName: name,
          displayNameSeenAt: name ? message.occurredAt : null,
          messageCount: 1,
          firstSeenAt: message.occurredAt,
          lastSeenAt: message.occurredAt,
        });
        continue;
      }

      existing.messageCount += 1;
      if (message.occurredAt < existing.firstSeenAt) existing.firstSeenAt = message.occurredAt;
      if (message.occurredAt > existing.lastSeenAt) existing.lastSeenAt = message.occurredAt;
      // Display names drift between messages ("J. Doe" then "Jane Doe");
      // the most recent non-empty one is the best guess at what the person
      // currently calls themselves.
      if (name && (!existing.displayNameSeenAt || message.occurredAt >= existing.displayNameSeenAt)) {
        existing.displayName = name;
        existing.displayNameSeenAt = message.occurredAt;
      }
    }
  }

  return [...byAddress.values()]
    .map(({ displayNameSeenAt: _displayNameSeenAt, ...contact }) => contact)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

export type RebuildContactsResult = { contactCount: number; messagesScanned: number };

/**
 * Recomputes and stores the identity's contact list from its messages.
 * Reads through findMessagesByIdentity, so it inherits that query's own
 * identity scoping and result cap rather than re-implementing either.
 */
export async function rebuildContactsForIdentity(identityId: string): Promise<RebuildContactsResult> {
  const [messages, sources] = await Promise.all([
    findMessagesByIdentity(identityId, { limit: 100 }),
    findConnectedSourcesByIdentity(identityId),
  ]);
  const derived = deriveContacts(messages, ownAddresses(sources));
  const contactCount = await replaceContactsForIdentity(identityId, derived);
  return { contactCount, messagesScanned: messages.length };
}
