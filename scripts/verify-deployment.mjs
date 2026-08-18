#!/usr/bin/env node
/**
 * Session 22c — check a real IDent deployment from outside, over HTTP.
 *
 * Ported from Receiptless's script of the same name rather than invented
 * again (external review item 4 says to reuse that shape, and it earned
 * the right: it caught a half-configured deployment on the first run).
 *
 * It reports **every** check rather than exiting on the first failure. A
 * deploy that fails three things should tell you three things, not one
 * per run — that is the difference between one debugging session and
 * three.
 *
 * What it cannot check, and does not pretend to, is listed at the end as
 * manual, so "verified" never quietly means "verified except the hard
 * parts".
 *
 * Usage:
 *   node scripts/verify-deployment.mjs https://api.ident.example
 */
const BASE = (process.argv[2] || process.env.DEPLOYMENT_URL || "").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 20_000);

if (!BASE) {
  console.error("usage: node scripts/verify-deployment.mjs <api-base-url>");
  process.exit(2);
}

const results = [];
const record = (name, ok, detail, manual = false) => results.push({ name, ok, detail, manual });

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, { redirect: "manual", signal: controller.signal, ...options });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function checkReadiness() {
  let payload;
  try {
    const response = await request("/health");
    payload = JSON.parse(response.text);
    record("Readiness endpoint reachable", true, `HTTP ${response.status}`);
  } catch (error) {
    record("Readiness endpoint reachable", false, `GET /health failed: ${error.message}`);
    return null;
  }

  // The database check is what proves this ran against real
  // infrastructure rather than a build artifact.
  record("Database reachable from the deployment", payload.db === "ok", `db: ${payload.db}`);

  const missing = payload.missingConfig ?? [];
  record(
    "All required configuration present",
    missing.length === 0,
    missing.length === 0 ? "nothing missing" : `missing: ${missing.join(", ")}`,
  );

  const insecure = payload.insecureConfig ?? [];
  record(
    "No configuration set to an unsafe value",
    insecure.length === 0,
    insecure.length === 0 ? "none" : `unsafe: ${insecure.join(", ")} — see DEPLOYMENT.md`,
  );

  // An older build that predates readiness reporting answers without these
  // keys at all. Silently passing would make this script useless exactly
  // when someone rolls back.
  record(
    "Deployment reports readiness, not just liveness",
    payload.missingConfig !== undefined,
    payload.missingConfig === undefined
      ? "no missingConfig field — this build predates session 22c"
      : "readiness fields present",
  );

  return payload;
}

async function checkRateLimiting() {
  // Enough unauthenticated login attempts to cross the per-IP bucket. The
  // point is not to guess the exact limit; it is that *something*
  // eventually refuses, because "no rate limiting anywhere" was a review
  // blocker and a deployment can silently disable it with one variable.
  let sawRefusal = false;
  let lastStatus = 0;
  for (let i = 0; i < 25 && !sawRefusal; i++) {
    const response = await request("/identity/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `verify_probe_${Date.now()}_${i}`, password: "not-a-real-password" }),
    });
    lastStatus = response.status;
    if (response.status === 429) sawRefusal = true;
  }
  record(
    "Login is rate limited",
    sawRefusal,
    sawRefusal ? "429 returned before 25 attempts" : `25 attempts, last status ${lastStatus}, never refused`,
  );
}

async function checkCors() {
  const response = await request("/identity/reminders/00000000-0000-0000-0000-000000000000", {
    method: "OPTIONS",
    headers: { origin: process.env.WEB_ORIGIN ?? BASE, "access-control-request-method": "DELETE" },
  });
  const allowed = response.headers.get("access-control-allow-methods") ?? "";
  record(
    "CORS preflight allows DELETE",
    allowed.includes("DELETE"),
    allowed ? `allowed: ${allowed}` : "no access-control-allow-methods header (is WEB_ORIGIN the deployed web origin?)",
  );
}

await checkReadiness();
await checkRateLimiting();
await checkCors();

record("Backups configured and a restore rehearsed", false, "provider dashboard + a real restore", true);
record("Centralised logs delivering", false, "check the log destination, not just that it is configured", true);
record("Rollback rehearsed against this deployment", false, "DEPLOYMENT.md §rollback", true);
record("A real Google account completed consent", false, "needs a human", true);

console.log(`\nVerifying ${BASE}\n`);
let failed = 0;
for (const { name, ok, detail, manual } of results) {
  if (manual) {
    console.log(`  MANUAL  ${name}\n          ${detail}`);
    continue;
  }
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}    ${name}\n          ${detail}`);
}

const automated = results.filter((result) => !result.manual);
console.log(`\n${automated.length - failed}/${automated.length} automated checks passed.`);
console.log("Items marked MANUAL are not checked here and are not implied by a green run.");
process.exit(failed > 0 ? 1 : 0);
