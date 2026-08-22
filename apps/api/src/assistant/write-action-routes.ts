import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import type { ActionExecutorRegistry, ExecutionResult } from "./write-actions/executors.js";
import { createWriteActionService, ActionRateLimitedError } from "./write-actions/write-action-service.js";
import { ActionConflictError, type PendingActionRow } from "./write-actions/types.js";

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

/**
 * The default executor when none is injected. Real execution needs a live
 * Google grant and a connection-service-backed token provider, which is the
 * one part of session 5 that cannot be verified without a real account —
 * until that is wired, execute reports a safe failure rather than pretending
 * to act. Tests and the wired deployment inject a real registry.
 */
const notConfiguredExecutor: ActionExecutorRegistry = {
  async execute(): Promise<ExecutionResult> {
    return { status: "failed", code: "executor_not_configured" };
  },
};

/** The display-safe projection of an action — never the internal columns raw. */
function toActionView(row: PendingActionRow) {
  const payload = JSON.parse(row.canonicalPayload) as Record<string, unknown>;
  let summary: Record<string, unknown>;
  if (row.actionType === "reply.draft") {
    summary = { kind: "reply.draft", to: payload.to, subject: payload.subject, body: payload.body };
  } else if (row.actionType === "message.archive") {
    summary = { kind: "message.archive", count: (payload.targets as unknown[] | undefined)?.length ?? 0 };
  } else {
    summary = { kind: "calendar.event.accept" };
  }
  return {
    id: row.id,
    actionType: row.actionType,
    status: row.status,
    payloadDigest: row.payloadDigest,
    expiresAt: row.expiresAt.toISOString(),
    outcomeCode: row.outcomeCode,
    summary,
  };
}

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof ActionConflictError) {
    // A cross-identity or missing action is a 404; every other conflict —
    // stale digest, wrong status, expired, already consumed — is a 409.
    if (error.reason === "not-found") return reply.code(404).send({ error: "Action not found." });
    return reply.code(409).send({ error: error.message, reason: error.reason });
  }
  if (error instanceof ActionRateLimitedError) {
    return reply
      .code(429)
      .headers({ "retry-after": String(error.retryAfterSeconds) })
      .send({ error: "Too many requests. Try again later." });
  }
  throw error;
}

export function registerWriteActionRoutes(
  app: FastifyInstance,
  executor: ActionExecutorRegistry = notConfiguredExecutor,
): void {
  const service = createWriteActionService(executor);

  app.get<{ Params: { id: string } }>("/identity/assistant/actions/:id", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    try {
      return toActionView(await service.getAction(identity.identityId, request.params.id));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: { payloadDigest?: unknown } }>(
    "/identity/assistant/actions/:id/confirm",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
      const digest = typeof request.body?.payloadDigest === "string" ? request.body.payloadDigest : "";
      if (!digest) return reply.code(400).send({ error: "payloadDigest is required." });
      try {
        const action = await service.confirmAction({
          identityId: identity.identityId,
          sessionId: identity.sessionId,
          actionId: request.params.id,
          payloadDigest: digest,
        });
        return toActionView(action);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { payloadDigest?: unknown } }>(
    "/identity/assistant/actions/:id/execute",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
      const digest = typeof request.body?.payloadDigest === "string" ? request.body.payloadDigest : "";
      if (!digest) return reply.code(400).send({ error: "payloadDigest is required." });
      try {
        const action = await service.executeAction({
          identityId: identity.identityId,
          actionId: request.params.id,
          payloadDigest: digest,
        });
        return toActionView(action);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/identity/assistant/actions/:id/cancel",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
      try {
        return toActionView(await service.cancelAction(identity.identityId, request.params.id));
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
