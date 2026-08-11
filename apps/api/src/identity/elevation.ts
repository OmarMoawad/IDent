import type { FastifyReply, FastifyRequest } from "fastify";
import { extractBearerToken } from "./http.js";
import { type AuthenticatedIdentity, validateSession } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    // Set only by requireElevatedSession below, once both the base session
    // and its elevation have been checked server-side — a handler behind
    // that hook can trust this is present and current, never a
    // client-supplied claim.
    elevatedIdentity?: AuthenticatedIdentity;
  }
}

export function isElevated(identity: Pick<AuthenticatedIdentity, "elevatedUntil">): boolean {
  return identity.elevatedUntil !== null && identity.elevatedUntil.getTime() > Date.now();
}

/**
 * The High/Critical-tier gate (SECURITY.md's tiering, IDent_STATE.md's
 * step-up requirement list): a Fastify preHandler, registered declaratively
 * via a route's `{ preHandler: requireElevatedSession }` option rather than
 * an inline check a handler body could omit — the framework runs it before
 * the handler unconditionally, so a route can't ship forgetting it the way
 * a copy-pasted `if (!identity) return 401` inline check could be dropped.
 * Elevation is decided fresh from the DB's sessions.elevatedUntil on every
 * call (via validateSession -> isElevated) — never from anything the
 * request itself claims.
 */
export async function requireElevatedSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);
  const identity = token ? await validateSession(token) : null;
  if (!identity) {
    await reply.code(401).send({ error: "Missing or invalid session token." });
    return;
  }
  if (!isElevated(identity)) {
    await reply
      .code(403)
      .send({ error: "This action requires a recent step-up verification. Re-verify to continue." });
    return;
  }
  request.elevatedIdentity = identity;
}
