import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import {
  findConnectedSourceById,
  findConnectedSourcesByIdentity,
  findMessageByIdForIdentity,
  findMessagesByIdentity,
  type ConnectedSource,
  type Message,
} from "./store.js";

type MessageQuery = { query?: string };
type MessageParams = { messageId: string };

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

function publicSource(source: ConnectedSource) {
  return {
    id: source.id,
    provider: source.provider,
    status: source.status,
    providerAccountEmail: source.providerAccountEmail,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function shapeMessage(message: Message, source: ConnectedSource | null) {
  return {
    ...message,
    source: source ? { id: source.id, provider: source.provider, providerAccountEmail: source.providerAccountEmail } : null,
  };
}

export function registerInboxRoutes(app: FastifyInstance): void {
  app.get("/identity/connections", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return (await findConnectedSourcesByIdentity(identity.identityId)).map(publicSource);
  });

  app.get<{ Querystring: MessageQuery }>("/identity/messages", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    const query = request.query.query?.trim() ?? "";
    if (query.length > 200) return reply.code(400).send({ error: "Search query must be 200 characters or fewer." });
    // Fetch the identity's sources once and join in memory, rather than a
    // per-message findConnectedSourceById (an N+1 across up to 100 rows).
    const [rows, sources] = await Promise.all([
      findMessagesByIdentity(identity.identityId, { query }),
      findConnectedSourcesByIdentity(identity.identityId),
    ]);
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    return rows.map((message) => shapeMessage(message, sourceById.get(message.sourceId) ?? null));
  });

  app.get<{ Params: MessageParams }>("/identity/messages/:messageId", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    const message = await findMessageByIdForIdentity(request.params.messageId, identity.identityId);
    if (!message) return reply.code(404).send({ error: "Message not found." });
    return shapeMessage(message, await findConnectedSourceById(message.sourceId));
  });
}
