# IDent State

**Read this file first, before anything else in this repo.** If the
instruction "read the repository and continue the currently approved
roadmap" doesn't work using only what's below, this file is out of date —
see [OPERATIONS.md](OPERATIONS.md).

Last updated: 2026-08-08 (session 3 — architecture-hardening pass: AMK key
hierarchy, immutable identity_id, modular-monolith note, AI/vault grant
mechanism, terminal wording, no-real-data gate, future-gaps log).

## Current phase

**Phase 0A — Repository becomes executable** (ROADMAP.md Era I). Core
checklist (migrations, CI, dependency audit) is now verified end-to-end.
Remaining 0A gaps are staging/prod-environment items that don't block
Phase 0B per the roadmap's gating rule (that rule gates on identity/data
integrity infra, not on hosting). Phase 0B (Identity Core) has not started.

### 0A checklist status

| Item | Status |
|---|---|
| Monorepo (npm workspaces: `apps/api`, `apps/web`, `packages/shared`) | Done |
| Backend skeleton (Fastify + TypeScript) | Done — `/health` only, no domain routes yet |
| Web client skeleton (Next.js App Router) | Done — placeholder page only |
| Database wiring (Postgres + Drizzle migrations) | **Verified against a live DB** — `docker compose up -d`, `db:generate`, `db:migrate` all run clean; `/health` returns `db: "ok"`. |
| Automated tests | Done for what exists — one vitest test on `/health`. Will need to grow with every new route. |
| CI/CD | **Verified on GitHub** — `gh run list` shows the Phase 0A scaffold push's CI run completed/success on `main`. |
| Dev/staging/production environments | Not started. Only local dev exists (docker-compose Postgres + `npm run dev:*`). No staging/prod hosting target chosen yet. Not a Phase 0B blocker. |
| Logging | Partial — Fastify's built-in pino logger is on by default (see the request logs in `npm run test` output). No log aggregation/shipping anywhere. |
| Monitoring | Not started. |
| Backups | Not started — no real database with real data yet, so nothing to back up. |
| Migration system | Done — Drizzle + drizzle-kit wired up; `src/db/schema.ts` has one infra-proving table (`system_health_checks`), not domain schema. |
| Infrastructure-as-code | Not started — docker-compose.yml covers local dev only, no Terraform/equivalent for staging/prod. |
| Dependency audit | Done — `npm audit` triaged; see "Dependency audit" section below. |

## Completed components (verified, not just attempted)

- `npm install`, `npm run typecheck`, `npm run test`, `npm run build` all
  pass from repo root as of this update (run right after this scaffold was
  created).
- `GET /health` on the API returns `{status, timestamp, db}`, and degrades
  correctly (`status: "degraded"`, `db: "unreachable"`) when Postgres isn't
  reachable, rather than crashing — verified by running `npm run dev:api`
  with no DB running and curling the endpoint directly.
- Next.js production build (`npm run build -w apps/web`) compiles and
  prerenders the placeholder page successfully.

## Architecture decisions made in this scaffold

- **npm workspaces**, not pnpm/Turborepo — pnpm wasn't installed on the
  build machine and plain npm workspaces are sufficient at this size. Revisit
  only if build times or hoisting actually become a problem.
- **Fastify + pino** for the API — matches the "thin clients, most logic
  server-side" principle in ARCHITECTURE.md; pino gives structured logs for
  free, which OPERATE-4 (actionable exception summaries, not a firehose)
  will eventually build on.
- **Drizzle + drizzle-kit** for migrations over Prisma — lighter runtime,
  SQL-first, and migrations are plain versioned files, which fits
  ARCHITECTURE.md's "no shared tables across modules" pattern (each domain
  service will get its own schema file under its own migration history).
- **`packages/shared` holds cross-app types only**, nothing with runtime
  logic yet — kept intentionally empty beyond `HealthStatus` until Phase 0B
  needs to share, e.g., a session-token shape between api and web.
- **Workspace build order matters**: `packages/*` must build before
  `apps/*` (root `package.json`'s `workspaces` array is ordered that way on
  purpose) because `@ident/api` and `@ident/web` import types from
  `@ident/shared`'s compiled `dist/`, not its `src/`.

## Dependency audit (2026-08-08)

Started at 12 vulnerabilities (6 moderate, 5 high, 1 critical). Fixed by
bumping direct dependencies (not `npm audit fix --force`, to control what
actually changed):

- `drizzle-orm` 0.36.4 → 0.45.2 (`apps/api/package.json`) — cleared a
  **high**-severity SQL-injection-via-identifiers advisory. Direct prod
  dependency, worth fixing now while the schema is trivial to re-verify.
- `drizzle-kit` 0.28.1 → 0.31.10 (`apps/api/package.json`) — dev tool.
- `vitest` 2.1.5 → 4.1.10 (`apps/api/package.json`) — cleared a
  **critical** RCE-via-`--ui` advisory (we don't use `--ui`, but no reason
  to carry it) plus the `vite`/`vite-node`/`esbuild` chain under it.
- `next` 15.0.3 → 16.3.0 (`apps/web/package.json`) — cleared **high**
  `postcss` (XSS/path-traversal in CSS sourcemaps) and **high** `sharp`
  (libvips CVEs) advisories. Only a placeholder page existed, so this was
  the cheapest point to take the major bump. Next auto-updated
  `apps/web/tsconfig.json` (`jsx: preserve` → `react-jsx`, added
  `.next/dev/types/**/*.ts` to `include`) and `next-env.d.ts` on `next
  build` — both are expected, mandatory changes for v16, not manual edits.
- Added `apps/api/vitest.config.ts` (`test.include: ["src/**/*.test.ts"]`)
  — vitest 4's discovery picked up the gitignored `apps/api/dist/*.test.js`
  build artifact as a second, duplicate test file whenever `dist/` existed
  locally (e.g. after running `build` before `test`). Harmless in CI
  (fresh checkout, no `dist/` yet) but would silently double-count tests
  locally. Root-caused and fixed rather than just `rm -rf dist`.

Typecheck, full test suite, and `npm run build` (all three workspaces)
re-verified green after each dependency bump.

**Remaining: 4 moderate**, all the same advisory
(GHSA-67mh-4wv8-2f99 — esbuild's dev server accepts requests from any
website) via `drizzle-kit@0.31.10 → @esbuild-kit/esm-loader → esbuild`.
0.31.10 is drizzle-kit's latest version and still carries this transitive
dependency — no upstream fix exists yet. `npm audit fix --force`'s
suggestion is to **downgrade** to `drizzle-kit@0.18.1`, which is not a real
fix. Accepted as a monitored risk: dev-only tooling, `drizzle-kit generate`
is a one-shot CLI invocation not a long-running dev server, so the
"malicious website hits your open dev server" exploit path doesn't apply
here. Re-check `npm audit` when drizzle-kit cuts a new release.

## Known failures / open issues

- No staging or production hosting target has been chosen. Nothing in this
  repo assumes one yet (no Dockerfile for the API, no deploy config). Not
  a Phase 0B blocker, but will need deciding before anything ships.
- Several install scripts (esbuild, sharp, fsevents) were blocked by the
  local npm config's `allowScripts` policy. Build/test/typecheck all still
  passed, so this hasn't caused a problem yet, but it's worth knowing about
  if something platform-specific breaks later (sharp in particular is
  image-processing native code — irrelevant until a module actually needs
  image handling).
- The new migration file (`apps/api/src/db/migrations/0000_large_emma_frost.sql`)
  and `apps/api/vitest.config.ts` are untracked as of this update — not yet
  committed/pushed. See "Next tasks" below.

## Hard gate: no real account data before ops infra exists

Staging/prod hosting, monitoring, backups, and IaC not blocking Phase 0B
*coding* (per the roadmap's gating rule above) is not the same as them not
blocking real users. Hard gate: **no real account gets created, and no
real user data is stored, in any environment beyond local dev, until
deployment, secrets management, monitoring, and backup/restore-testing
exist for that environment.** Local dev with synthetic data is unaffected
by this gate.

## Known future architecture gaps (not blocking, revisit at the relevant phase)

Logged so a future session doesn't have to rediscover these; none of them
block Phase 0B and none should be designed now:

- **Telecom identity/routing plane** (Phase 10) — ARCHITECTURE.md's
  Integration Adapters only lists carrier APIs as a generic example.
  Needs its own section (`identity_id` → `@username` → communications
  endpoints → policy/routing engine → channel adapters, with phone
  numbers/eSIM IDs/SIP addresses as replaceable endpoint attributes) once
  Phase 10 actually starts.
- **Entitlement/billing separation** (Phase 5+) — BOOTSTRAP.md has pricing
  tiers but no canonical split between identity ownership, subscription
  entitlement, and usage billing. Needed before Phase 5's metered services
  ship, so a lapsed Maintenance payment can't delete an identity and a
  telecom suspension can't cut off Vault access.
- **AI capability/permission object model** (Phase 1+, grows with write
  actions) — "scoped access" and "per-action confirmation" are stated as
  principles (ROADMAP.md's AI Assistant table) but not as a reusable
  primitive. Worth formalizing as the assistant's action surface grows
  past Phase 2's write actions, so AI permissions are ordinary short-lived
  delegated capabilities rather than special-cased per module.
- **Append-only audit/event architecture** — audit logging is referenced
  per-module (vault shares, biometric payment authorizations) but has no
  first-class, tamper-evident, cross-module design yet. Worth doing once
  enough modules exist to need a shared retention/query story.

## Next tasks, in order

1. Review and commit the pending changes (dependency bumps in both
   `package.json`s, `package-lock.json`, the generated migration file, the
   new `apps/api/vitest.config.ts`, and the Next-auto-generated
   `tsconfig.json`/`next-env.d.ts` diffs), then push and re-confirm CI is
   still green with the new dependency versions.
2. Only then: start Phase 0B (Identity Core) — username+password identity,
   passkey/WebAuthn, session/key management, per ARCHITECTURE.md's Identity
   Core section.

## Deployment instructions

None yet — there is no staging or production target. Local-only: see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Security assumptions

- Nothing sensitive is stored anywhere in this repo yet — no user data, no
  credentials, no keys. The only table that exists (`system_health_checks`)
  holds a timestamp and nothing else.
- `.env` is gitignored; `.env.example` has placeholder local-dev credentials
  only (`ident`/`ident`), never used outside `docker-compose.yml`'s local
  container.
- No auth exists yet at all — the API has one public, unauthenticated route
  (`/health`). This is fine only because Phase 0A adds no other routes;
  Phase 0B must not ship a second route without auth already in place.

## External approvals pending

None. Nothing in Phase 0A depends on a third party, a regulator, or a
partner — that starts much later (earliest: Phase 5a's financial
aggregator partner, or Phase 10's telecom partners — see ROADMAP.md).
