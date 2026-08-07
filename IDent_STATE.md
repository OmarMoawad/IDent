# IDent State

**Read this file first, before anything else in this repo.** If the
instruction "read the repository and continue the currently approved
roadmap" doesn't work using only what's below, this file is out of date —
see [OPERATIONS.md](OPERATIONS.md).

Last updated: 2026-08-08.

## Current phase

**Phase 0A — Repository becomes executable** (ROADMAP.md Era I). In
progress, not complete. Phase 0B (Identity Core) has not started — do not
add auth/session/user schema before 0A's checklist below is actually done,
per the roadmap's own gating rule.

### 0A checklist status

| Item | Status |
|---|---|
| Monorepo (npm workspaces: `apps/api`, `apps/web`, `packages/shared`) | Done |
| Backend skeleton (Fastify + TypeScript) | Done — `/health` only, no domain routes yet |
| Web client skeleton (Next.js App Router) | Done — placeholder page only |
| Database wiring (Postgres + Drizzle migrations) | Scaffolded, typechecked; **not yet run against a live DB in this environment** — Docker daemon wasn't running when this was built. Untested past `npm run typecheck`/`build`. |
| Automated tests | Done for what exists — one vitest test on `/health`. Will need to grow with every new route. |
| CI/CD | Done — `.github/workflows/ci.yml` runs typecheck → test → build with a Postgres service container. **Not yet verified on an actual push to GitHub** — only run locally as three separate `npm run` commands. |
| Dev/staging/production environments | Not started. Only local dev exists (docker-compose Postgres + `npm run dev:*`). No staging/prod hosting target chosen yet. |
| Logging | Partial — Fastify's built-in pino logger is on by default (see the request logs in `npm run test` output). No log aggregation/shipping anywhere. |
| Monitoring | Not started. |
| Backups | Not started — no real database with real data yet, so nothing to back up. |
| Migration system | Done — Drizzle + drizzle-kit wired up; `src/db/schema.ts` has one infra-proving table (`system_health_checks`), not domain schema. |
| Infrastructure-as-code | Not started — docker-compose.yml covers local dev only, no Terraform/equivalent for staging/prod. |

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

## Known failures / open issues

- Database migration path (`npm run db:generate`/`db:migrate` in
  `apps/api`) is **untested against a live database** — Docker wasn't
  running when this was built. Next session: `docker compose up -d`, then
  run both commands, then confirm `/health` reports `db: "ok"`.
- CI workflow (`.github/workflows/ci.yml`) has never actually run on GitHub
  — it was written to mirror the three local commands exactly, but a real
  push/PR run hasn't happened yet.
- No staging or production hosting target has been chosen. Nothing in this
  repo assumes one yet (no Dockerfile for the API, no deploy config).
- `npm install` reported 12 vulnerabilities (6 moderate, 5 high, 1 critical)
  in transitive dependencies — not triaged yet. Run `npm audit` before
  Phase 0B ships anything user-facing.
- Several install scripts (esbuild, sharp, fsevents) were blocked by the
  local npm config's `allowScripts` policy. Build/test/typecheck all still
  passed, so this hasn't caused a problem yet, but it's worth knowing about
  if something platform-specific breaks later (sharp in particular is
  image-processing native code — irrelevant until a module actually needs
  image handling).

## Next tasks, in order

1. Get Docker running locally, then actually run the migration path
   end-to-end and confirm `/health` reports `db: "ok"`.
2. Push this branch and confirm `.github/workflows/ci.yml` actually goes
   green on GitHub, not just locally.
3. Run `npm audit` and triage the reported vulnerabilities before adding
   anything user-facing.
4. Only then: start Phase 0B (Identity Core) — username+password identity,
   passkey/WebAuthn, session/key management, per ARCHITECTURE.md's Identity
   Core section. Do not start this before items 1–3 above are done.

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
