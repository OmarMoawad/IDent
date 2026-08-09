import type { FastifyInstance } from "fastify";
import {
  InvalidCredentialsError,
  InvalidUsernameError,
  UsernameTakenError,
  WeakPasswordError,
  loginWithPassword,
  logout,
  register,
  validateSession,
} from "./service.js";

type RegisterBody = { username?: unknown; password?: unknown; wrappedAmkKey?: unknown };
type LoginBody = { username?: unknown; password?: unknown };

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function requireStrings(body: Record<string, unknown>, keys: string[]): string[] | null {
  const values = keys.map((key) => body[key]);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) return null;
  return values as string[];
}

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
}
