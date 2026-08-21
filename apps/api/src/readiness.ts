import { resolveTokenEncryptionKey } from "./comms/comms-config.js";
import { isDeployedEnvironment } from "./deployment.js";

/**
 * Session 22c, external review item 4 (the production foundation).
 *
 * Its own module rather than part of `deployment.ts` because it has to
 * ask `comms-config.ts` whether the encryption key is safe, and
 * `comms-config.ts` already imports `deployment.ts` — putting these there
 * would be an import cycle. The dependency direction is the reason, not
 * tidiness.
 */

/**
 * Configuration that must exist before a deployment serves real traffic.
 *
 * Returned as a list rather than thrown, so `/health` can report
 * everything missing at once instead of one item per redeploy — a lesson
 * taken from Receiptless, where discovering misconfiguration one variable
 * at a time cost an afternoon of deploys.
 */
export function missingProductionConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isDeployedEnvironment(env)) return [];

  const missing = ["DATABASE_URL", "COMMS_TOKEN_ENCRYPTION_KEY"].filter((key) => !env[key]?.trim());

  /**
   * WebAuthn binds every credential to the origin it was created on, and
   * the defaults are `localhost`. A deployment that leaves these unset
   * does not fail loudly — it registers passkeys against the wrong
   * relying party, and they stop verifying later, which is the worst
   * possible time to find out. Required, not optional.
   */
  for (const key of ["WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN"]) {
    if (!env[key]?.trim()) missing.push(key);
  }

  /**
   * Google OAuth is optional as a feature, but a *partial* configuration
   * is worse than none: a connect flow that starts and cannot finish
   * looks like a bug in IDent rather than a missing setting.
   */
  const googleKeys = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"];
  const googleSet = googleKeys.filter((key) => env[key]?.trim());
  if (googleSet.length > 0 && googleSet.length < googleKeys.length) {
    missing.push(...googleKeys.filter((key) => !env[key]?.trim()));
  }

  return missing;
}

/**
 * Configuration that is present but unsafe. Distinct from "missing"
 * because the fix is different: one is "add this", the other is "the
 * value you have is dangerous".
 */
export function insecureProductionConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isDeployedEnvironment(env)) return [];
  const problems: string[] = [];

  // Resolution throws on exactly the unsafe cases — missing, blank, wrong
  // length, or the committed dev key. Asking it and catching beats
  // restating the rule here, where the two copies would drift.
  try {
    resolveTokenEncryptionKey(env);
  } catch {
    problems.push("COMMS_TOKEN_ENCRYPTION_KEY");
  }

  // A deployment still pointing WebAuthn at localhost has credentials
  // bound to an origin no user will ever visit.
  if (env.WEBAUTHN_RP_ID?.trim() === "localhost") problems.push("WEBAUTHN_RP_ID");
  if (env.WEBAUTHN_ORIGIN?.trim().startsWith("http://localhost")) problems.push("WEBAUTHN_ORIGIN");

  // Enforcement is on by default everywhere but tests; switching it off in
  // a deployment removes every rate limit in the service at once.
  const rateLimitFlag = env.RATE_LIMIT_ENFORCE?.trim().toLowerCase();
  if (rateLimitFlag === "0" || rateLimitFlag === "false") problems.push("RATE_LIMIT_ENFORCE");

  return problems;
}

export type ReadinessReport = {
  status: "ok" | "degraded";
  db: "ok" | "unreachable";
  /** Names only, never values — this endpoint is unauthenticated. */
  missingConfig: string[];
  insecureConfig: string[];
};

export function readinessFrom(db: "ok" | "unreachable", env: NodeJS.ProcessEnv = process.env): ReadinessReport {
  const missingConfig = missingProductionConfig(env);
  const insecureConfig = insecureProductionConfig(env);
  return {
    status: db === "ok" && missingConfig.length === 0 && insecureConfig.length === 0 ? "ok" : "degraded",
    db,
    missingConfig,
    insecureConfig,
  };
}

/**
 * The build this process is running, as reported by the platform that
 * started it.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA` and `RAILWAY_GIT_BRANCH` into
 * every deployment; Vercel's equivalents are read too so the same check
 * works if the API ever moves. `GIT_COMMIT_SHA` is the manual override
 * for anywhere else.
 *
 * Returns an empty object rather than "unknown" when nothing is set —
 * `/health` should omit the field locally instead of asserting a fact it
 * does not have.
 */
export function buildProvenance(env: NodeJS.ProcessEnv = process.env): {
  commit?: string;
  branch?: string;
} {
  const commit =
    env.RAILWAY_GIT_COMMIT_SHA ?? env.VERCEL_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA;
  const branch =
    env.RAILWAY_GIT_BRANCH ?? env.VERCEL_GIT_COMMIT_REF ?? env.GIT_BRANCH;

  return {
    ...(commit?.trim() ? { commit: commit.trim() } : {}),
    ...(branch?.trim() ? { branch: branch.trim() } : {}),
  };
}
