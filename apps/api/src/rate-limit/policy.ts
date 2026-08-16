/**
 * Session 22b, external-review item 2: **IDent had no rate limiting
 * anywhere.** Registration, login, recovery, elevation, WebAuthn
 * verification, notification ingest, sync and the assistant were all
 * unthrottled. Argon2 makes login the worst of them — it is deliberately
 * expensive, so an unthrottled login endpoint is a CPU exhaustion vector
 * as well as a password-guessing one, and the cheap request is the
 * attacker's.
 *
 * The same finding was raised against Receiptless, so the review asked
 * for **one approach across both repos**, not two. What is shared is the
 * design, not the code (different stacks, different ORMs): a fixed-window
 * counter in Postgres, incremented by a single atomic statement, keyed by
 * `(bucket, subject)`; the same bucket names; the same limits; the same
 * 429 + `Retry-After` shape. Receiptless's copy is `src/lib/rate-limit/`.
 *
 * Why Postgres rather than an in-memory counter: Receiptless runs on
 * Vercel, where every request may hit a different instance and an
 * in-memory counter would limit nothing. A per-process counter would have
 * been fine for IDent alone, and picking it would have meant two designs
 * for one property — which is how the two repos drift.
 *
 * Why fixed-window rather than a token bucket or sliding log: a fixed
 * window is one statement and one row, and its known weakness (up to 2x
 * the limit across a window boundary) does not matter at these numbers.
 * A sliding window is worth the cost when a limit is a billing boundary,
 * not when it is a brake.
 */
export type RateLimitPolicy = {
  /** Namespace for the counter row. Shared verbatim with Receiptless. */
  bucket: string;
  /** How the caller is identified — see resolveSubject in plugin.ts. */
  subject: SubjectKind;
  /** Requests permitted per window. The (limit + 1)th is refused. */
  limit: number;
  windowSeconds: number;
};

export type SubjectKind =
  /** Client IP. The only option before a session exists. */
  | "ip"
  /** A hash of the bearer session token, falling back to IP when absent. */
  | "session"
  /** The username in the request body — see the note on login below. */
  | "username"
  /** A hash of the notification ingest token, falling back to IP. */
  | "ingest-token";

const MINUTE = 60;
const HOUR = 60 * 60;

/**
 * Login is limited **twice**, and the second limit is the one that
 * matters. Per-IP alone stops one machine grinding one account; it does
 * nothing against a spread-out attempt at a single account from many
 * addresses, which is the shape credential stuffing actually takes. The
 * per-username counter costs one extra row and closes that.
 *
 * The cost, stated rather than hidden: a per-username limit lets a third
 * party lock a known username out of password login for the window by
 * spending failures against it. That is why the number is per-window
 * rather than cumulative, why it is generous enough that a real user
 * fumbling a password is unaffected, and why passkey login is on a
 * separate bucket — an account with a passkey always keeps a working way
 * in. Recording it here because it is a real trade-off, not an oversight.
 */
export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  "auth-login-ip": { bucket: "auth-login-ip", subject: "ip", limit: 20, windowSeconds: 15 * MINUTE },
  "auth-login-username": { bucket: "auth-login-username", subject: "username", limit: 8, windowSeconds: 15 * MINUTE },
  "auth-register": { bucket: "auth-register", subject: "ip", limit: 10, windowSeconds: HOUR },
  "auth-recovery": { bucket: "auth-recovery", subject: "ip", limit: 10, windowSeconds: HOUR },
  "auth-webauthn": { bucket: "auth-webauthn", subject: "ip", limit: 30, windowSeconds: 15 * MINUTE },
  "auth-elevate": { bucket: "auth-elevate", subject: "session", limit: 15, windowSeconds: 15 * MINUTE },
  /**
   * Ingest is a machine-to-machine endpoint, so its ceiling is higher than
   * anything a person drives — high enough that a normal sender never
   * meets it, low enough that a runaway one cannot fill the messages
   * table unattended.
   */
  "notification-ingest": { bucket: "notification-ingest", subject: "ingest-token", limit: 120, windowSeconds: MINUTE },
  /** Each sync is up to 26 Google API calls; this bounds our own egress too. */
  "provider-sync": { bucket: "provider-sync", subject: "session", limit: 12, windowSeconds: 5 * MINUTE },
  /** Paid third-party inference. A runaway client here costs real money. */
  "assistant": { bucket: "assistant", subject: "session", limit: 30, windowSeconds: HOUR },
  /** Catch-alls, so a route added later is never completely unthrottled. */
  "default-write": { bucket: "default-write", subject: "session", limit: 120, windowSeconds: MINUTE },
  "default-read": { bucket: "default-read", subject: "session", limit: 600, windowSeconds: MINUTE },
};

type Rule = { method: string; url: string; policies: string[] };

/**
 * Explicit route rules. Everything not listed falls through to
 * `default-read`/`default-write`, which is the point: a new route is
 * throttled the day it is written, and tightening it is a deliberate
 * edit here rather than something someone has to remember.
 */
const RULES: Rule[] = [
  { method: "POST", url: "/identity/login", policies: ["auth-login-ip", "auth-login-username"] },
  { method: "POST", url: "/identity/recovery/login", policies: ["auth-login-ip", "auth-login-username"] },
  { method: "POST", url: "/identity/register", policies: ["auth-register"] },
  { method: "POST", url: "/identity/recovery/generate", policies: ["auth-recovery"] },
  { method: "PUT", url: "/identity/recovery/wrap", policies: ["auth-recovery"] },
  { method: "POST", url: "/identity/webauthn/register/options", policies: ["auth-webauthn"] },
  { method: "POST", url: "/identity/webauthn/register/verify", policies: ["auth-webauthn"] },
  { method: "POST", url: "/identity/webauthn/login/options", policies: ["auth-webauthn"] },
  { method: "POST", url: "/identity/webauthn/login/verify", policies: ["auth-webauthn"] },
  { method: "POST", url: "/identity/elevate/password", policies: ["auth-elevate"] },
  { method: "POST", url: "/identity/elevate/recovery", policies: ["auth-elevate"] },
  { method: "POST", url: "/identity/elevate/webauthn/options", policies: ["auth-elevate"] },
  { method: "POST", url: "/identity/elevate/webauthn/verify", policies: ["auth-elevate"] },
  { method: "POST", url: "/notifications/ingest", policies: ["notification-ingest"] },
  { method: "POST", url: "/notifications/ingest/:token", policies: ["notification-ingest"] },
  { method: "POST", url: "/identity/connections/gmail/:sourceId/sync", policies: ["provider-sync"] },
  { method: "POST", url: "/identity/contacts/rebuild", policies: ["provider-sync"] },
  { method: "POST", url: "/identity/assistant/ask", policies: ["assistant"] },
  { method: "POST", url: "/identity/priorities/classify", policies: ["assistant"] },
];

/**
 * `/health` is exempt: an uptime probe that trips a rate limit reports an
 * outage that isn't happening, and the endpoint touches one `SELECT 1`.
 * The OAuth callback is exempt from the *default-write* path only in the
 * sense that it is a GET; it still gets `default-read`.
 */
const EXEMPT: ReadonlySet<string> = new Set(["/health"]);

export function policiesForRoute(method: string, url: string | undefined): RateLimitPolicy[] {
  if (!url || EXEMPT.has(url)) return [];

  const rule = RULES.find((candidate) => candidate.method === method && candidate.url === url);
  if (rule) return rule.policies.map((name) => RATE_LIMIT_POLICIES[name]);

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return [RATE_LIMIT_POLICIES["default-read"]];
  return [RATE_LIMIT_POLICIES["default-write"]];
}

/**
 * Enforcement is **on everywhere except the test suite**, where it is off
 * unless a test asks for it.
 *
 * That exception is a real weakening and is worth being plain about: it
 * means the ordinary route tests prove nothing about throttling. The
 * alternative was worse — every test file shares one Postgres and one
 * loopback address, so a suite-wide limit would make unrelated tests fail
 * each other in ways that look exactly like the load flakes this repo has
 * already misdiagnosed twice. The rate-limit tests set
 * RATE_LIMIT_ENFORCE=1 and use distinct subjects, so the enforced path is
 * covered on purpose rather than incidentally.
 */
export function isRateLimitEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.RATE_LIMIT_ENFORCE?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return env.NODE_ENV !== "test";
}
