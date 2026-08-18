import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { NOTIFICATION_TOKEN_HEADER } from "../notifications/notification-service.js";
import { isRateLimitEnforced, policiesForRoute, type RateLimitPolicy, type SubjectKind } from "./policy.js";
import { countRequest, pruneExpiredCounters } from "./store.js";

/**
 * Bearer tokens and ingest tokens are hashed before they are ever used as
 * a counter subject. The `rate_limit_counters` table would otherwise hold
 * live credentials in a column nothing treats as secret — the same defect
 * the notification ingest token had in session 20, where it reached the
 * request log through `req.url`. Truncated because a rate limit key needs
 * to be unique, not collision-proof against an adversary who already has
 * the token.
 */
function hashed(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 32);
}

/**
 * `request.ip` is the socket address unless Fastify is configured with
 * `trustProxy`, which it is not. Behind a reverse proxy every request
 * would then share the proxy's address and one caller's flood would
 * throttle everyone — so this is deliberately left alone here and called
 * out in OPERATIONS.md instead: enabling `trustProxy` is part of putting
 * this service behind a proxy, and enabling it *without* a proxy would
 * let any caller forge `X-Forwarded-For` and evade every IP limit.
 */
function clientIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function resolveSubject(kind: SubjectKind, request: FastifyRequest): string | null {
  switch (kind) {
    case "ip":
      return `ip:${clientIp(request)}`;
    case "session": {
      const token = extractBearerToken(request.headers.authorization);
      // An unauthenticated caller on a session-keyed bucket still gets
      // counted — by IP — rather than skipped. "No session" must not be
      // the way to opt out of a limit.
      return token ? `session:${hashed(token)}` : `ip:${clientIp(request)}`;
    }
    case "username": {
      const body = request.body as { username?: unknown } | undefined;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      // No username in the body means the route will 400 anyway; the IP
      // limit on the same route already counted the attempt.
      return username ? `username:${username}` : null;
    }
    case "ingest-token": {
      const header = request.headers[NOTIFICATION_TOKEN_HEADER];
      const fromHeader = typeof header === "string" ? header : undefined;
      const params = request.params as { token?: string } | undefined;
      const token = fromHeader ?? params?.token;
      return token ? `ingest:${hashed(token)}` : `ip:${clientIp(request)}`;
    }
  }
}

/**
 * Housekeeping, kept off the request path's critical section: at most one
 * prune per process per interval, started from the request that notices
 * the interval has elapsed and deliberately **not** awaited. A failure is
 * logged and otherwise ignored — a full counters table is a size problem,
 * never a reason to fail a user's request.
 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

function maybePrune(request: FastifyRequest): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  void pruneExpiredCounters().catch((err) => {
    request.log.warn({ err }, "rate limit counter prune failed");
  });
}

async function applyPolicy(
  policy: RateLimitPolicy,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const subject = resolveSubject(policy.subject, request);
  if (!subject) return true;

  const verdict = await countRequest(policy, subject);
  if (verdict.allowed) return true;

  /**
   * A refusal says how long to wait and nothing else. It does not say
   * which limit was hit, what the limit is, or how many attempts remain:
   * on `auth-login-username` that would confirm a username exists to
   * someone probing for one, and the ingest endpoint's whole design
   * (session 20) is that it never distinguishes a live token from a dead
   * one. The owner's view of their own limits belongs in an authenticated
   * response, not in the refusal.
   */
  request.log.warn(
    { bucket: policy.bucket, route: request.routeOptions.url, count: verdict.count },
    "rate limit exceeded",
  );
  await reply
    .code(429)
    .header("retry-after", String(verdict.retryAfterSeconds))
    .send({ error: "Too many requests. Try again later." });
  return false;
}

/**
 * Registered as one `preHandler` hook rather than per-route decoration,
 * so there is a single place that decides what is throttled and no route
 * can be added without a limit — the review's finding was that *nothing*
 * was limited, and a design where each route opts in reproduces it one
 * forgotten route at a time. `preHandler` rather than `onRequest` because
 * the login limit keys on the username in the body, which is not parsed
 * yet at `onRequest`.
 */
export function registerRateLimiting(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!isRateLimitEnforced()) return;

    const policies = policiesForRoute(request.method, request.routeOptions.url);
    if (policies.length === 0) return;

    maybePrune(request);

    for (const policy of policies) {
      const allowed = await applyPolicy(policy, request, reply);
      // Returning the reply tells Fastify the response is already sent.
      if (!allowed) return reply;
    }
  });
}
