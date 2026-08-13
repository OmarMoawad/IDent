import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import {
  getOrCreateNotificationToken,
  ingestNotification,
  InvalidNotificationError,
} from "./notification-service.js";

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

export function registerNotificationRoutes(app: FastifyInstance): void {
  /**
   * The user's own ingest endpoint, to paste into a third-party service's
   * webhook configuration. Session-authenticated: the token is a
   * credential, so only its owner may read it.
   */
  app.get("/identity/notifications/endpoint", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const token = await getOrCreateNotificationToken(identity.identityId);
    return { token, path: `/notifications/ingest/${token}` };
  });

  /**
   * The ingest path itself. Deliberately *not* session-authenticated —
   * the caller is a third-party service, and the opaque token in the URL
   * is the credential, the same design as Receiptless's inbound webhook.
   *
   * An unknown token returns 202, not 404: a 404 would let anyone probe
   * which tokens exist, and there is nothing useful a legitimate caller
   * could do with the distinction anyway.
   */
  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    "/notifications/ingest/:token",
    async (request, reply) => {
      try {
        const result = await ingestNotification(request.params.token, request.body ?? {});
        if (result.status === "unknown-endpoint") return reply.code(202).send({ status: "accepted" });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof InvalidNotificationError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
