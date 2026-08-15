import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import {
  getNotificationEndpointStatus,
  ingestNotification,
  NOTIFICATION_TOKEN_HEADER,
  rotateNotificationToken,
} from "./notification-service.js";

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

export function registerNotificationRoutes(app: FastifyInstance): void {
  /**
   * Status only — deliberately never the token. Only the hash is stored, so
   * the plaintext is unrecoverable after minting; `lastError` is how the
   * owner debugs a sender, since the ingest endpoint tells the sender
   * nothing.
   */
  app.get("/identity/notifications/endpoint", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return getNotificationEndpointStatus(identity.identityId);
  });

  /**
   * Mint or rotate. Returns the plaintext **once** — this is the only
   * response in the system that ever contains it. Rotation doubles as
   * revocation: the old hash is overwritten.
   */
  app.post("/identity/notifications/endpoint", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const token = await rotateNotificationToken(identity.identityId);
    return reply.code(201).send({
      token,
      header: NOTIFICATION_TOKEN_HEADER,
      path: "/notifications/ingest",
      /**
       * The required payload shape, returned with the token because the
       * UI previously showed the endpoint and the header and nothing
       * about the body — so following the on-screen instructions exactly
       * produced a rejection ("app is required") that the sender never
       * sees, since ingest always answers 202. Found in session 22's
       * click-through.
       */
      requiredFields: ["app", "title"],
      optionalFields: ["body", "externalId", "occurredAt", "actionUrl"],
      example: { app: "GitHub", title: "Build passed", body: "main is green." },
      // Said plainly because the UI cannot show it again.
      notice: "Copy this now — it is stored only as a hash and cannot be shown again.",
    });
  });

  /**
   * The ingest path. The caller is a third-party service, so there is no
   * session; the token is the credential.
   *
   * It travels in a **header**, not the URL, because Fastify logs
   * `req.url` on every request — a credential in the path lands in
   * application logs and any proxy or tracing system downstream. The
   * `:token` URL form is still accepted for senders that cannot set
   * headers, and app.ts redacts that path before it reaches the logger.
   *
   * Always answers 202, whatever happens. See ingestNotification.
   */
  const handler = async (request: FastifyRequest<{ Params: { token?: string }; Body: Record<string, unknown> }>) => {
    const header = request.headers[NOTIFICATION_TOKEN_HEADER];
    const token = (typeof header === "string" && header) || request.params.token || "";
    const result = await ingestNotification(token, request.body ?? {});
    // An unexpected fault is logged, never signalled: a 500 here would be
    // reachable only with a live token, which is the exact distinction the
    // uniform 202 exists to remove. The literal below, rather than
    // `result`, is also what keeps messageId off the wire.
    if (result.internalError) {
      request.log.error({ err: result.internalError }, "notification ingest failed unexpectedly");
    }
    return { status: "accepted" };
  };

  app.post<{ Params: { token?: string }; Body: Record<string, unknown> }>(
    "/notifications/ingest",
    async (request, reply) => reply.code(202).send(await handler(request)),
  );

  app.post<{ Params: { token?: string }; Body: Record<string, unknown> }>(
    "/notifications/ingest/:token",
    async (request, reply) => reply.code(202).send(await handler(request)),
  );
}
