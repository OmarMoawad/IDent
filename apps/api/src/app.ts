import Fastify, { type FastifyInstance } from "fastify";
import type { HealthStatus } from "@ident/shared";
import { checkDbHealth } from "./db/pool.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { registerWebauthnRoutes } from "./identity/webauthn-routes.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

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
