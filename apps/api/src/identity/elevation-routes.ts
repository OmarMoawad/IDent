import type { FastifyInstance } from "fastify";
import { requireElevatedSession } from "./elevation.js";
import { extractBearerToken, requireStrings } from "./http.js";
import { ElevationVerificationError, elevateWithPassword, elevateWithRecoveryCode, validateSession } from "./service.js";
import { elevateWithPasskeyAssertion, getAuthenticationOptions } from "./webauthn-service.js";

type ElevatePasswordBody = { password?: unknown };
type ElevateRecoveryBody = { recoveryCode?: unknown };
type ElevateWebauthnVerifyBody = { response?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function registerElevationRoutes(app: FastifyInstance): void {
  app.post<{ Body: ElevatePasswordBody }>("/identity/elevate/password", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const fields = requireStrings(request.body ?? {}, ["password"]);
    if (!fields) return reply.code(400).send({ error: "password is required." });
    const [password] = fields;

    try {
      const elevatedUntil = await elevateWithPassword(identity, password);
      return reply.code(200).send({ elevatedUntil: elevatedUntil.toISOString() });
    } catch (err) {
      if (err instanceof ElevationVerificationError) return reply.code(401).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Body: ElevateRecoveryBody }>("/identity/elevate/recovery", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const fields = requireStrings(request.body ?? {}, ["recoveryCode"]);
    if (!fields) return reply.code(400).send({ error: "recoveryCode is required." });
    const [recoveryCode] = fields;

    try {
      const elevatedUntil = await elevateWithRecoveryCode(identity, recoveryCode);
      return reply.code(200).send({ elevatedUntil: elevatedUntil.toISOString() });
    } catch (err) {
      if (err instanceof ElevationVerificationError) return reply.code(401).send({ error: err.message });
      throw err;
    }
  });

  app.post("/identity/elevate/webauthn/options", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    // Scoped to this already-authenticated identity's own username — same
    // ceremony a passkey login uses (webauthn-service's
    // getAuthenticationOptions), just requested by an already-logged-in
    // caller instead of an anonymous login attempt.
    const options = await getAuthenticationOptions(identity.username);
    return reply.code(200).send(options);
  });

  app.post<{ Body: ElevateWebauthnVerifyBody }>("/identity/elevate/webauthn/verify", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const body = request.body ?? {};
    if (!isRecord(body.response)) return reply.code(400).send({ error: "response is required." });

    try {
      const elevatedUntil = await elevateWithPasskeyAssertion(
        identity,
        body.response as unknown as Parameters<typeof elevateWithPasskeyAssertion>[1],
      );
      return reply.code(200).send({ elevatedUntil: elevatedUntil.toISOString() });
    } catch (err) {
      if (err instanceof ElevationVerificationError) return reply.code(401).send({ error: err.message });
      throw err;
    }
  });

  // Synthetic demo-only route: no real High/Critical-tier module exists yet
  // (those are Phase 3+ per ROADMAP.md), so this exists purely to prove the
  // elevation mechanism end-to-end — including a real browser click-through,
  // which needs something real to click (IDent_STATE.md's session-12 design
  // note). Delete once a real High/Critical route ships and can carry this
  // proof instead.
  app.get("/identity/demo/high-tier-secret", { preHandler: requireElevatedSession }, async (request, reply) => {
    const identity = request.elevatedIdentity!;
    return reply.code(200).send({
      secret: "You reached a High/Critical-tier route because this session is elevated.",
      identityId: identity.identityId,
      elevatedUntil: identity.elevatedUntil!.toISOString(),
    });
  });
}
