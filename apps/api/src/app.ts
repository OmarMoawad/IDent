import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { HealthStatus } from "@ident/shared";
import { registerGmailRoutes } from "./comms/gmail-routes.js";
import { registerAssistantRoutes } from "./assistant/assistant-routes.js";
import { registerWriteActionRoutes } from "./assistant/write-action-routes.js";
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
import { registerRateLimiting } from "./rate-limit/plugin.js";
import { buildProvenance, readinessFrom } from "./readiness.js";

/**
 * Query parameters that are safe to keep, and worth keeping. `error` and
 * `error_description` are the provider's own diagnosis of a failed
 * consent — `access_denied` when someone declines, or the message naming
 * an API that has not been enabled, which is precisely what made the
 * first production callback failure readable. Dropping the whole query
 * string would have thrown that away along with the credential.
 *
 * They are provider-authored text rather than our own, so they are
 * echoed into logs and nowhere else.
 */
const LOGGABLE_CALLBACK_PARAMS = ["error", "error_description"] as const;

/**
 * Matches any connector's callback, not just Gmail's. The connector
 * abstraction exists so that there will be more than one provider, and a
 * pattern anchored to the literal `gmail` path would log the next
 * provider's authorization code in the clear on the day it was added —
 * silently, and in exactly the place this redaction was written to
 * protect. `[^/?#]+` is the provider segment.
 */
const OAUTH_CALLBACK_URL = /^(\/identity\/connections\/[^/?#]+\/callback)\?(.*)$/;

function redactCallbackQuery(url: string): string {
  const match = OAUTH_CALLBACK_URL.exec(url);
  if (!match) return url;

  const [, path, query] = match;
  const parsed = new URLSearchParams(query);
  const kept = new URLSearchParams();
  for (const name of LOGGABLE_CALLBACK_PARAMS) {
    const value = parsed.get(name);
    if (value !== null) kept.set(name, value);
  }

  const preserved = kept.toString();
  return `${path}?${preserved ? `${preserved}&` : ""}[redacted]`;
}

/**
 * Every URL redaction this service performs, in one function, because
 * `req.url` is not the only place a URL reaches the log. Fastify's
 * default not-found handler builds its message from the raw URL and logs
 * it — so a callback that arrives at a path no route serves (a redirect
 * URI typed wrong in a provider console, a connector renamed, or someone
 * probing) wrote a live authorization code into the log through a door
 * the serializer does not cover. Anything that logs a URL calls this.
 */
export function redactSensitiveUrl(url: string): string {
  return redactCallbackQuery(url.replace(/^(\/notifications\/ingest)\/[^/?#]+/, "$1/[redacted]"));
}

/**
 * `loggerStream` exists so a test can assert on what actually reaches the
 * log output — see notifications/log-redaction.test.ts. Production passes
 * nothing and gets Fastify's default destination.
 */
export function buildApp(
  options: { loggerStream?: { write(chunk: string): void }; trustProxy?: boolean } = {},
): FastifyInstance {
  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
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
         *
         * An OAuth provider returns its one-time authorization code and
         * the state value in the callback query string, so those routes
         * keep their useful path in logs and lose the query — see
         * `redactCallbackQuery` for what survives and why.
         */
        req(request: FastifyRequest) {
          const url = redactSensitiveUrl(request.url);
          return {
            method: request.method,
            url,
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

  // Before any route: session 22b, external-review item 2. One hook for
  // the whole surface — see rate-limit/policy.ts for what each route gets
  // and why the counter lives in Postgres.
  registerRateLimiting(app);

  /**
   * Liveness *and* readiness (session 22c, external review item 4). A
   * service can be up and answering while missing the configuration that
   * makes it safe to serve — WebAuthn still bound to localhost, no
   * encryption key — and the old version of this endpoint reported "ok"
   * for exactly that state.
   *
   * Reports configuration **names, never values**: it is unauthenticated
   * by design, because an uptime probe cannot hold a credential.
   */
  app.get("/health", async (): Promise<HealthStatus> => {
    const db = await checkDbHealth();
    const readiness = readinessFrom(db);
    return { ...readiness, ...buildProvenance(), timestamp: new Date().toISOString() };
  });

  registerIdentityRoutes(app);
  registerWebauthnRoutes(app);
  registerElevationRoutes(app);
  registerGmailRoutes(app);
  registerInboxRoutes(app);
  registerContactRoutes(app);
  registerCalendarRoutes(app);
  registerAssistantRoutes(app);
  registerWriteActionRoutes(app);
  registerImportanceRoutes(app);
  registerNotificationRoutes(app);

  /**
   * Replaces Fastify's default, which logs and returns
   * `Route GET:<raw url> not found`. That raw URL is the leak: it is
   * built before any route matched, so it carries whatever query the
   * caller sent — including an OAuth authorization code that arrived at
   * the wrong path. Same redaction as the serializer, in both the log
   * line and the body, since the body is what a provider's browser
   * redirect would render on screen.
   */
  app.setNotFoundHandler((request, reply) => {
    const url = redactSensitiveUrl(request.url);
    request.log.info(`Route ${request.method}:${url} not found`);
    return reply.code(404).send({
      message: `Route ${request.method}:${url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  return app;
}
