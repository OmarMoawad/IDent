import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthStatus } from "@ident/shared";
import { checkDbHealth } from "./db/pool.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { registerWebauthnRoutes } from "./identity/webauthn-routes.js";
import { ORIGIN } from "./identity/webauthn-config.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Same trusted origin WebAuthn already expects (identity/webauthn-config's
  // ORIGIN) — apps/web talks to this API cross-origin in dev (3000 -> 4000),
  // and there's no cookie/session state for CORS to protect beyond the
  // bearer token the client sends explicitly, so a single allowed origin is
  // enough for now.
  app.register(cors, { origin: [ORIGIN] });

  app.get("/health", async (): Promise<HealthStatus> => {
    const db = await checkDbHealth();
    return {
      status: db === "ok" ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      db,
    };
  });

  registerIdentityRoutes(app);
  registerWebauthnRoutes(app);

  return app;
}
