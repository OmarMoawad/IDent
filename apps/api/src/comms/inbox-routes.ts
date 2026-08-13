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

async function publicMessage(message: Message) {
  const source = await findConnectedSourceById(message.sourceId);
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
    return Promise.all((await findMessagesByIdentity(identity.identityId, { query })).map(publicMessage));
  });

  app.get<{ Params: MessageParams }>("/identity/messages/:messageId", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    const message = await findMessageByIdForIdentity(request.params.messageId, identity.identityId);
    if (!message) return reply.code(404).send({ error: "Message not found." });
    return publicMessage(message);
  });
}
