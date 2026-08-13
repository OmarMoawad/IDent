import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthStatus } from "@ident/shared";
import { registerGmailRoutes } from "./comms/gmail-routes.js";
import { registerAssistantRoutes } from "./assistant/assistant-routes.js";
import { registerImportanceRoutes } from "./assistant/importance-routes.js";
import { registerCalendarRoutes } from "./comms/calendar-routes.js";
import { registerNotificationRoutes } from "./notifications/notification-routes.js";
import { registerContactRoutes } from "./comms/contacts-routes.js";
import { registerInboxRoutes } from "./comms/inbox-routes.js";
import { checkDbHealth } from "./db/pool.js";
import { registerElevationRoutes } from "./identity/elevation-routes.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { registerWebauthnRoutes } from "./identity/webauthn-routes.js";
import { ORIGIN } from "./identity/webauthn-config.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Same trusted origin WebAuthn already expects (identity/webauthn-config's
  // ORIGIN) — apps/web talks to this API cross-origin in dev (3000 -> 4000),
  // and there's no cookie/session state for CORS to protect beyond the
  // bearer token the client sends explicitly, so a single allowed origin is
  // enough for now. methods must be listed explicitly: @fastify/cors
  // defaults to GET/HEAD/POST only, which silently blocked the browser's
  // preflight for PUT /identity/recovery/wrap (curl and vitest's
  // app.inject() both bypass CORS entirely, so neither caught this — only
  // a real browser's preflight does).
  app.register(cors, { origin: [ORIGIN], methods: ["GET", "HEAD", "POST", "PUT"] });

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
  registerElevationRoutes(app);
  registerGmailRoutes(app);
  registerInboxRoutes(app);
  registerContactRoutes(app);
  registerCalendarRoutes(app);
  registerAssistantRoutes(app);
  registerImportanceRoutes(app);
  registerNotificationRoutes(app);

  return app;
}
