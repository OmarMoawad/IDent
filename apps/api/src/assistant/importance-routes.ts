import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import { findConnectedSourcesByIdentity } from "../comms/store.js";
import {
  classifyMessagesForIdentity,
  createPriorityRule,
  deletePriorityRule,
  findPrioritiesByIdentity,
  findPriorityRules,
  isPriorityLevel,
  overrideMessagePriority,
} from "./importance-service.js";

/** Bounded so a rule row can't be used to store arbitrary bulk text. */
const MAX_MATCH_VALUE_LENGTH = 320; // RFC 5321's maximum email address length
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

export function registerImportanceRoutes(app: FastifyInstance): void {
  /**
   * Priorities are exposed as a *separate* list rather than folded into
   * the message list, so nothing about this feature can accidentally
   * become a filter: a client that ignores this endpoint sees every
   * message exactly as before.
   */
  app.get("/identity/priorities", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return findPrioritiesByIdentity(identity.identityId);
  });

  app.post("/identity/priorities/classify", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return classifyMessagesForIdentity(identity.identityId);
  });

  /** Override one call — the finer of the two overrides the roadmap requires. */
  app.post<{ Params: { messageId: string }; Body: { level?: unknown } }>(
    "/identity/priorities/:messageId",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
      if (!isPriorityLevel(request.body?.level)) {
        return reply.code(400).send({ error: "level must be one of: high, normal, low." });
      }
      const updated = await overrideMessagePriority(identity.identityId, request.params.messageId, request.body.level);
      if (!updated) return reply.code(404).send({ error: "Message not found." });
      return { status: "updated", level: request.body.level };
    },
  );

  app.get("/identity/priority-rules", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    return findPriorityRules(identity.identityId);
  });

  /** Override the rule behind the call — the coarser override. */
  app.post<{ Body: { matchType?: unknown; matchValue?: unknown; level?: unknown } }>(
    "/identity/priority-rules",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

      const { matchType, matchValue, level } = request.body ?? {};
      if (matchType !== "contact" && matchType !== "source") {
        return reply.code(400).send({ error: "matchType must be 'contact' or 'source'." });
      }
      if (typeof matchValue !== "string" || !matchValue.trim()) {
        return reply.code(400).send({ error: "matchValue is required." });
      }
      if (!isPriorityLevel(level)) {
        return reply.code(400).send({ error: "level must be one of: high, normal, low." });
      }

      // Validate the target. An unvalidated rule doesn't leak anything,
      // but it creates a dead rule that silently never matches — the user
      // believes they've tuned something and nothing changes, which is
      // exactly the un-negotiated behaviour this feature is meant to avoid.
      const trimmed = matchValue.trim();
      if (trimmed.length > MAX_MATCH_VALUE_LENGTH) {
        return reply.code(400).send({ error: `matchValue must be ${MAX_MATCH_VALUE_LENGTH} characters or fewer.` });
      }
      if (matchType === "contact" && !EMAIL_SHAPE.test(trimmed)) {
        return reply.code(400).send({ error: "A contact rule needs an email address." });
      }
      if (matchType === "source") {
        const owned = await findConnectedSourcesByIdentity(identity.identityId);
        // Scoped to this identity, so a foreign source id reads as unknown
        // rather than confirming that it exists.
        if (!owned.some((source) => source.id === trimmed)) {
          return reply.code(404).send({ error: "Connected source not found." });
        }
      }

      const rule = await createPriorityRule({
        identityId: identity.identityId,
        matchType,
        matchValue: trimmed,
        level,
      });
      return reply.code(201).send(rule);
    },
  );

  app.delete<{ Params: { ruleId: string } }>("/identity/priority-rules/:ruleId", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    if (!(await deletePriorityRule(request.params.ruleId, identity.identityId))) {
      return reply.code(404).send({ error: "Rule not found." });
    }
    return reply.code(204).send();
  });
}
