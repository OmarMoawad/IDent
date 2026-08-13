import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import { ASSISTANT_MODEL } from "./assistant-config.js";
import { askAssistant, QuestionTooLongError } from "./assistant-service.js";
import { AssistantUnavailableError, createConfiguredClaudeClient, type ClaudeClient } from "./claude-client.js";

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

/**
 * `clientFactory` is injectable so tests supply a fake and never reach the
 * network — the same seam the Gmail and Calendar routes use.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  clientFactory: () => ClaudeClient | null = createConfiguredClaudeClient,
): void {
  /**
   * Lets the UI tell the user, before they ask anything, whether the
   * assistant is available and which provider their data would reach.
   * Disclosure is a product requirement here, not a nicety — see
   * SECURITY.md.
   */
  app.get("/identity/assistant/status", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return { available: clientFactory() !== null, provider: "anthropic", model: ASSISTANT_MODEL };
  });

  app.post<{ Body: { question?: unknown } }>("/identity/assistant/ask", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const question = typeof request.body?.question === "string" ? request.body.question : "";

    try {
      const result = await askAssistant(identity.identityId, question, clientFactory());
      return result;
    } catch (error) {
      if (error instanceof QuestionTooLongError) return reply.code(400).send({ error: error.message });
      if (error instanceof AssistantUnavailableError) {
        return reply.code(503).send({ error: "The assistant is not configured." });
      }
      // Never surface a provider error verbatim, and never *log* it
      // whole either: an SDK error carries request/response metadata, and
      // this request's body is the person's retrieved inbox. Log only the
      // fields needed to diagnose a failure — class, status, and the
      // provider's request id, which is the useful one for support.
      const sdkError = error as { name?: string; status?: number; request_id?: string };
      request.log.error(
        {
          errorName: typeof sdkError?.name === "string" ? sdkError.name : "Unknown",
          status: typeof sdkError?.status === "number" ? sdkError.status : undefined,
          providerRequestId: typeof sdkError?.request_id === "string" ? sdkError.request_id : undefined,
        },
        "assistant request failed",
      );
      return reply.code(502).send({ error: "The assistant could not answer right now." });
    }
  });
}
