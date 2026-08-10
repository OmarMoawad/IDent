import type { FastifyInstance } from "fastify";
import { extractBearerToken, requireStrings } from "./http.js";
import { InvalidUsernameError, UsernameTakenError, validateSession } from "./service.js";
import {
  ChallengeExpiredError,
  UnknownCredentialError,
  UnknownUsernameError,
  WebauthnVerificationError,
  getAuthenticationOptions,
  getPasswordlessRegistrationOptions,
  getRegistrationOptions,
  verifyAuthentication,
  verifyPasswordlessRegistration,
  verifyRegistration,
} from "./webauthn-service.js";

type RegisterVerifyBody = { response?: unknown; wrappedAmkKey?: unknown };
type LoginOptionsBody = { username?: unknown };
type LoginVerifyBody = { username?: unknown; response?: unknown };
type RegisterIdentityOptionsBody = { username?: unknown };
type RegisterIdentityVerifyBody = { username?: unknown; response?: unknown; wrappedAmkKey?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function registerWebauthnRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterIdentityOptionsBody }>(
    "/identity/webauthn/register-identity/options",
    async (request, reply) => {
      const fields = requireStrings(request.body ?? {}, ["username"]);
      if (!fields) return reply.code(400).send({ error: "username is required." });
      const [username] = fields;

      try {
        const options = await getPasswordlessRegistrationOptions(username);
        return reply.code(200).send(options);
      } catch (err) {
        if (err instanceof InvalidUsernameError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Body: RegisterIdentityVerifyBody }>(
    "/identity/webauthn/register-identity/verify",
    async (request, reply) => {
      const body = request.body ?? {};
      const username = body.username;
      const wrappedAmkKey = body.wrappedAmkKey;
      if (
        typeof username !== "string" ||
        username.length === 0 ||
        typeof wrappedAmkKey !== "string" ||
        wrappedAmkKey.length === 0 ||
        !isRecord(body.response)
      ) {
        return reply.code(400).send({ error: "username, response, and wrappedAmkKey are required." });
      }

      try {
        const result = await verifyPasswordlessRegistration(
          username,
          body.response as unknown as Parameters<typeof verifyPasswordlessRegistration>[1],
          wrappedAmkKey,
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof InvalidUsernameError || err instanceof ChallengeExpiredError || err instanceof WebauthnVerificationError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof UsernameTakenError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post("/identity/webauthn/register/options", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const options = await getRegistrationOptions(identity.identityId, identity.username);
    return reply.code(200).send(options);
  });

  app.post<{ Body: RegisterVerifyBody }>("/identity/webauthn/register/verify", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const body = request.body ?? {};
    const wrappedAmkKey = body.wrappedAmkKey;
    if (!isRecord(body.response) || typeof wrappedAmkKey !== "string" || wrappedAmkKey.length === 0) {
      return reply.code(400).send({ error: "response and wrappedAmkKey are required." });
    }

    try {
      // The library validates response shape/signatures itself; a
      // structurally-wrong object just fails verification (see
      // webauthn-service's .catch), it never reaches unsafe code.
      await verifyRegistration(
        identity.identityId,
        body.response as unknown as Parameters<typeof verifyRegistration>[1],
        wrappedAmkKey,
      );
      return reply.code(201).send({ ok: true });
    } catch (err) {
      if (err instanceof ChallengeExpiredError || err instanceof WebauthnVerificationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: LoginOptionsBody }>("/identity/webauthn/login/options", async (request, reply) => {
    const fields = requireStrings(request.body ?? {}, ["username"]);
    if (!fields) return reply.code(400).send({ error: "username is required." });
    const [username] = fields;

    try {
      const options = await getAuthenticationOptions(username);
      return reply.code(200).send(options);
    } catch (err) {
      if (err instanceof UnknownUsernameError) return reply.code(401).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Body: LoginVerifyBody }>("/identity/webauthn/login/verify", async (request, reply) => {
    const body = request.body ?? {};
    const username = body.username;
    if (typeof username !== "string" || username.length === 0 || !isRecord(body.response)) {
      return reply.code(400).send({ error: "username and response are required." });
    }

    try {
      const session = await verifyAuthentication(
        username,
        body.response as unknown as Parameters<typeof verifyAuthentication>[1],
      );
      return reply.code(200).send(session);
    } catch (err) {
      if (
        err instanceof UnknownUsernameError ||
        err instanceof ChallengeExpiredError ||
        err instanceof UnknownCredentialError ||
        err instanceof WebauthnVerificationError
      ) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });
}
