import type { FastifyInstance } from "fastify";
import { extractBearerToken, requireStrings } from "./http.js";
import {
  InvalidCredentialsError,
  InvalidUsernameError,
  UsernameTakenError,
  WeakPasswordError,
  getAmkWrap,
  loginWithPassword,
  logout,
  register,
  validateSession,
} from "./service.js";

type RegisterBody = { username?: unknown; password?: unknown; wrappedAmkKey?: unknown };
type LoginBody = { username?: unknown; password?: unknown };
type AmkWrapQuery = { factor?: unknown };

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

    return reply.code(200).send({ identityId: identity.identityId, username: identity.username });
  });

  app.get<{ Querystring: AmkWrapQuery }>("/identity/amk-wrap", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const factor = typeof request.query.factor === "string" && request.query.factor.length > 0
      ? request.query.factor
      : "password";

    const wrappedKey = await getAmkWrap(identity.identityId, factor);
    if (!wrappedKey) return reply.code(404).send({ error: `No AMK wrap stored for factor "${factor}".` });

    return reply.code(200).send({ factor, wrappedKey });
  });
}
