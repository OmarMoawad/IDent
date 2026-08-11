import type { FastifyInstance } from "fastify";
import { extractBearerToken, requireStrings } from "./http.js";
import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  InvalidUsernameError,
  UsernameTakenError,
  WeakPasswordError,
  generateRecoveryCode,
  getAmkWrap,
  loginWithPassword,
  loginWithRecoveryCode,
  logout,
  register,
  setRecoveryAmkWrap,
  validateSession,
} from "./service.js";
import { getPasskeyAmkWrap } from "./webauthn-service.js";

type RegisterBody = { username?: unknown; password?: unknown; wrappedAmkKey?: unknown };
type LoginBody = { username?: unknown; password?: unknown };
type RecoveryLoginBody = { username?: unknown; recoveryCode?: unknown };
type RecoveryWrapBody = { wrappedAmkKey?: unknown };
type AmkWrapQuery = { factor?: unknown; credentialId?: unknown };

export function registerIdentityRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegisterBody }>("/identity/register", async (request, reply) => {
    const fields = requireStrings(request.body ?? {}, ["username", "password", "wrappedAmkKey"]);
    if (!fields) {
      return reply.code(400).send({ error: "username, password, and wrappedAmkKey are required." });
    }
    const [username, password, wrappedAmkKey] = fields;

    try {
      const session = await register({ username, password, wrappedAmkKey });
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof InvalidUsernameError || err instanceof WeakPasswordError) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof UsernameTakenError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: LoginBody }>("/identity/login", async (request, reply) => {
    const fields = requireStrings(request.body ?? {}, ["username", "password"]);
    if (!fields) {
      return reply.code(400).send({ error: "username and password are required." });
    }
    const [username, password] = fields;

    try {
      const session = await loginWithPassword({ username, password });
      return reply.code(200).send(session);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: RecoveryLoginBody }>("/identity/recovery/login", async (request, reply) => {
    const fields = requireStrings(request.body ?? {}, ["username", "recoveryCode"]);
    if (!fields) {
      return reply.code(400).send({ error: "username and recoveryCode are required." });
    }
    const [username, recoveryCode] = fields;

    try {
      const session = await loginWithRecoveryCode({ username, recoveryCode });
      return reply.code(200).send(session);
    } catch (err) {
      if (err instanceof InvalidRecoveryCodeError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/identity/recovery/generate", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const recoveryCode = await generateRecoveryCode(identity.identityId);
    return reply.code(201).send({ recoveryCode });
  });

  app.put<{ Body: RecoveryWrapBody }>("/identity/recovery/wrap", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const fields = requireStrings(request.body ?? {}, ["wrappedAmkKey"]);
    if (!fields) return reply.code(400).send({ error: "wrappedAmkKey is required." });
    const [wrappedAmkKey] = fields;

    await setRecoveryAmkWrap(identity.identityId, wrappedAmkKey);
    return reply.code(204).send();
  });

  app.post("/identity/logout", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return reply.code(401).send({ error: "Missing bearer session token." });

    await logout(token);
    return reply.code(204).send();
  });

  app.get("/identity/me", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    return reply.code(200).send({
      identityId: identity.identityId,
      username: identity.username,
      elevatedUntil: identity.elevatedUntil ? identity.elevatedUntil.toISOString() : null,
    });
  });

  app.get<{ Querystring: AmkWrapQuery }>("/identity/amk-wrap", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const factor = typeof request.query.factor === "string" && request.query.factor.length > 0
      ? request.query.factor
      : "password";

    let wrappedKey: string | null;
    if (factor === "passkey") {
      // Unlike "password", "passkey" isn't a single interchangeable
      // secret — each credential has its own wrap (see passkey_amk_wraps'
      // comment in schema.ts), so the caller must say which one it just
      // authenticated with.
      const credentialId = typeof request.query.credentialId === "string" ? request.query.credentialId : "";
      if (!credentialId) {
        return reply.code(400).send({ error: 'credentialId is required for factor "passkey".' });
      }
      wrappedKey = await getPasskeyAmkWrap(identity.identityId, credentialId);
    } else {
      wrappedKey = await getAmkWrap(identity.identityId, factor);
    }

    if (!wrappedKey) return reply.code(404).send({ error: `No AMK wrap stored for factor "${factor}".` });

    return reply.code(200).send({ factor, wrappedKey });
  });
}
