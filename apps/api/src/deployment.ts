/**
 * "Is it safe for the public internet to reach this?" answered in code
 * rather than in a doc comment.
 *
 * Ported from Receiptless's `src/lib/deployment.ts` (session 22b, review
 * item 3) rather than invented a second time: that repo hit the same
 * problem first — a committed dev-only encryption key with a silent
 * fallback — and its gate was observed firing in production on
 * 2026-08-15. Two designs for one property is how the two repos drift.
 *
 * IDent has no Vercel equivalent to Receiptless's `VERCEL_ENV`, so
 * `NODE_ENV` is the whole signal here, plus an explicit `IDENT_ENV`
 * escape hatch for a host that sets neither (a bare `node dist/index.js`
 * on a VPS inherits no NODE_ENV at all). Anything that is not clearly
 * local development counts as deployed: the failure mode of guessing
 * "deployed" wrongly is a refused boot with a precise message, and the
 * failure mode of guessing "local" wrongly is real refresh tokens
 * encrypted under a key published in this repository.
 */
export function isDeployedEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.IDENT_ENV?.trim().toLowerCase();
  if (explicit) return explicit !== "development" && explicit !== "test";
  return env.NODE_ENV === "production";
}
