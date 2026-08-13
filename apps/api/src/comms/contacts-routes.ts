import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseMessageParticipants, participantKey } from "@ident/shared";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import { findContactByIdForIdentity, findContactsByIdentity, type Contact } from "./contacts-store.js";
import { rebuildContactsForIdentity } from "./contacts-service.js";
import { findMessagesByIdentity } from "./store.js";

type ContactQuery = { query?: string };
type ContactParams = { contactId: string };

const MAX_QUERY_LENGTH = 200;
const MAX_CONTACT_MESSAGES = 20;

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

/**
 * identityId is intentionally dropped: the caller is that identity by
 * construction, so echoing it back adds nothing and puts an internal
 * identifier on the wire — the same sanitizing convention publicSource
 * follows in inbox-routes.ts.
 */
function publicContact(contact: Contact) {
  return {
    id: contact.id,
    address: contact.address,
    displayName: contact.displayName,
    messageCount: contact.messageCount,
    firstSeenAt: contact.firstSeenAt,
    lastSeenAt: contact.lastSeenAt,
  };
}

export function registerContactRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ContactQuery }>("/identity/contacts", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    const query = request.query.query?.trim() ?? "";
    if (query.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ error: `Search query must be ${MAX_QUERY_LENGTH} characters or fewer.` });
    }
    return (await findContactsByIdentity(identity.identityId, { query })).map(publicContact);
  });

  /**
   * Rebuilds from the identity's current messages. A POST because it
   * writes, and explicit rather than automatic on read so a contact list
   * stays a cheap indexed lookup — the inbox's own sync flow is the
   * natural caller (see the web client).
   */
  app.post("/identity/contacts/rebuild", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return rebuildContactsForIdentity(identity.identityId);
  });

  app.get<{ Params: ContactParams }>("/identity/contacts/:contactId", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    const contact = await findContactByIdForIdentity(request.params.contactId, identity.identityId);
    if (!contact) return reply.code(404).send({ error: "Contact not found." });

    // The contact's recent messages, filtered from the identity's own
    // already-scoped message list — never a separate unscoped query.
    const messages = (await findMessagesByIdentity(identity.identityId, { limit: 100 }))
      .filter((message) => {
        const { from, to } = parseMessageParticipants(message.participants);
        return [...from, ...to].some((participant) => participantKey(participant.address) === contact.address);
      })
      .slice(0, MAX_CONTACT_MESSAGES)
      .map((message) => ({
        id: message.id,
        subject: message.subject,
        snippet: message.snippet,
        occurredAt: message.occurredAt,
        isRead: message.isRead,
      }));

    return { ...publicContact(contact), messages };
  });
}
