import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
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

/**
 * `loggerStream` exists so a test can assert on what actually reaches the
 * log output — see notifications/log-redaction.test.ts. Production passes
 * nothing and gets Fastify's default destination.
 */
export function buildApp(options: { loggerStream?: { write(chunk: string): void } } = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
      serializers: {
        /**
         * Fastify logs `req.url` on every request. The notification ingest
         * route accepts its bearer token as a URL path segment (for senders
         * that cannot set headers), so without this the credential is
         * written into application logs — and from there into whatever
         * ships them onward. Redacted at the serializer so it is scrubbed
         * for every log line of that request, not just the access log.
         *
         * The header form carries no credential in the URL and is the
         * preferred path; this covers the compatibility fallback.
         */
        req(request: FastifyRequest) {
          return {
            method: request.method,
            url: request.url.replace(/^(\/notifications\/ingest)\/[^/?#]+/, "$1/[redacted]"),
            host: request.headers.host,
            remoteAddress: request.ip,
          };
        },
      },
    },
  });

  // Same trusted origin WebAuthn already expects (identity/webauthn-config's
  // ORIGIN) — apps/web talks to this API cross-origin in dev (3000 -> 4000),
  // and there's no cookie/session state for CORS to protect beyond the
  // bearer token the client sends explicitly, so a single allowed origin is
  // enough for now. methods must be listed explicitly: @fastify/cors
  // defaults to GET/HEAD/POST only, which silently blocked the browser's
  // preflight for PUT /identity/recovery/wrap (curl and vitest's
  // app.inject() both bypass CORS entirely, so neither caught this — only
  // a real browser's preflight does).
  //
  // DELETE was added in session 22b, for exactly the same reason and with
  // exactly the same blind spot: two DELETE routes exist (a reminder, and
  // a priority rule), both authenticated, both unreachable from a browser
  // because the preflight was answered without their method. Every test
  // passed the whole time. The list is enumerated from the routes that
  // exist rather than widened to "all methods", so the next route with a
  // new verb fails loudly here instead of quietly in a browser.
  app.register(cors, {
    origin: [ORIGIN],
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
  });

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
