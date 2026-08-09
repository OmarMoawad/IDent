# IDent State

**Read this file first, before anything else in this repo.** If the
instruction "read the repository and continue the currently approved
roadmap" doesn't work using only what's below, this file is out of date —
see [OPERATIONS.md](OPERATIONS.md).

Last updated: 2026-08-09 (session 5 — Phase 0B slice: passkey/WebAuthn.
Registration and authentication ceremonies via @simplewebauthn/server,
webauthn_credentials/webauthn_challenges tables, a hand-rolled software
authenticator so tests exercise real ECDSA signature verification. Real
client-side AMK generation is still not built — see "Next tasks" below).

## Current phase

**Phase 0B — Identity Core** (ROADMAP.md Phase 0), in progress. Phase 0A
(ROADMAP.md Era I) is fully done — see its checklist below, unchanged since
session 3.

Done so far: a user can register with a username + password, log in
(including a second concurrent session — nothing prevents multiple active
sessions per identity, which is what "log in from two devices" in Phase 0's
exit criteria requires), call `/identity/me` with the returned bearer token,
log out to revoke that specific session, register a passkey on an
already-logged-in identity, and log in with that passkey instead of a
password. Password hashes, session tokens, and passkey credentials/
signatures are all real (scrypt, sha256-hashed tokens, genuine ECDSA P-256
verification) — none of this is stubbed.

Not done: real client-side AMK generation (apps/web is still a placeholder
— see below), step-up auth for High/Critical tier modules, and any UI at
all (this slice is API-only, exercised via `app.inject` in tests and
curl/HTTP by hand — there is no navigator.credentials call anywhere, the
software authenticator in tests replaces the browser entirely).

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
- Phase 0B: `identities`, `username_aliases`, `password_credentials`,
  `account_master_key_wraps`, and `sessions` tables exist and migrated
  clean against a live Postgres (migration `0001_stormy_silk_fever.sql`).
  `POST /identity/register`, `POST /identity/login`, `POST /identity/logout`,
  and `GET /identity/me` are implemented and covered by 16 passing tests run
  against that live DB (register success/duplicate-username/invalid-
  username/weak-password, login success/wrong-password/unknown-username,
  session validation success/missing-token/invalid-token, logout revokes the
  session so a follow-up `/identity/me` with the same token now 401s).
  `npm run typecheck`, `npm run test`, and `npm run build` all pass across
  every workspace with this slice in.
- Passkey/WebAuthn: `webauthn_credentials` and `webauthn_challenges` tables
  (migration `0002_sweet_bloodstrike.sql`), `POST /identity/webauthn/
  register/options`, `/register/verify`, `/login/options`, `/login/verify`.
  7 new tests (23 total in the API workspace now) cover: successful passkey
  registration, registration rejected without a session, a consumed
  registration challenge can't be replayed, successful passkey login end to
  end (including that the returned session actually authenticates against
  `/identity/me`), login-options rejected for an unknown username, a
  tampered assertion signature rejected, and a consumed login challenge
  can't be replayed. All of it runs against real
  `@simplewebauthn/server` verification and a hand-rolled software
  authenticator (`identity/test-support/software-authenticator.ts`) that
  generates genuine ECDSA P-256 keypairs and signs real CBOR-encoded
  attestation/assertion data — no step of the crypto path is mocked.

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
- **Password hashing is Node's built-in `crypto.scrypt`, not a new
  dependency (no argon2/bcrypt package added)**. OWASP-recommended params
  (N=2^17, r=8, p=1, ~128 MiB/hash), PHC-like encoding
  (`scrypt$N$r$p$salt$hash`) so params travel with each hash and can be
  tuned up later without breaking old ones. Chosen specifically to avoid
  argon2's native-addon build step, given the dependency audit already
  logged native install scripts (esbuild, sharp, fsevents) getting blocked
  by this machine's `allowScripts` policy — scrypt needed zero new deps and
  zero native builds.
- **Session tokens are a random 32-byte value returned once at issuance;
  only its sha256 hash is ever persisted** (`sessions.token_hash`), so a
  database read alone can't produce a usable session token. Base session
  TTL is 24h with no refresh-token flow yet (SECURITY.md's tiering implies a
  shorter step-up session on top of this base one for High/Critical
  modules — not built this slice, see "Next tasks").
- **Login is timing-safe against username enumeration**: a login for a
  username that doesn't exist still runs a full scrypt verify (against a
  fixed dummy hash, computed once and cached) before returning 401, so
  "no such user" and "wrong password" take the same wall-clock time.
- **`validateSession()` is a plain function other modules import directly,
  not an HTTP call to Identity Core** — matches ARCHITECTURE.md's
  current-phase note that Phase 0–2 is a modular monolith. Becomes a real
  network call only once a module is split into its own deployment.
- **`account_master_key_wraps.wrapped_key` is accepted from the caller as
  an opaque string and never interpreted server-side.** Nothing generates a
  *real* Account Master Key yet — apps/web is still a placeholder page with
  no WebCrypto in it — so today `wrappedAmkKey` is just whatever the caller
  (currently: tests) sends. The column and the "never unwrap server-side"
  contract exist now because retrofitting them after real user data exists
  is expensive; the actual client-side AMK generation is unbuilt, tracked
  in "Next tasks."
- **`@simplewebauthn/server` for WebAuthn, not a hand-rolled verifier.**
  Attestation/assertion verification (CBOR parsing, COSE key handling,
  ECDSA/RSA signature checks, origin/RP-ID/counter validation) is exactly
  the kind of security-critical parsing code that should use a vetted
  library, unlike password hashing where Node's own `crypto.scrypt`
  sufficed. Pure-JS dependency tree (`@hexagon/base64`,
  `@levischuck/tiny-cbor`, `@peculiar/*`) — no native builds, consistent
  with the scrypt decision's reasoning.
- **A passkey is registered as a second factor on an already-authenticated
  identity, not as a way to create one.** `/identity/webauthn/register/*`
  requires a valid bearer session; there's no passwordless sign-up path
  yet. Matches ARCHITECTURE.md's "password remains a fallback" — passkey
  is additive here, not a replacement, until passwordless registration is
  deliberately designed (recovery-path implications if the *only* factor
  is a passkey and the device is lost aren't addressed yet).
- **The passkey's AMK wrap is opaque-passthrough, same convention as
  password's** — `wrappedAmkKey` in `/register/verify`'s body is stored
  under `account_master_key_wraps` with `factor: 'passkey'` and never
  interpreted server-side. Real passkey-derived AMK wrapping needs the
  WebAuthn PRF (or largeBlob) extension, whose browser/authenticator
  support is inconsistent enough that designing it now would be guessing;
  deferred on purpose (see "Next tasks"), not an oversight.
- **Login-options for an unknown username returns 401, unlike password
  login** — password login is timing-safe against username enumeration
  (a dummy scrypt verify runs either way); `/identity/webauthn/login/
  options` doesn't have an equivalent camouflage, because faking a
  plausible `allowCredentials` list for a nonexistent identity without a
  real per-user deterministic-but-unlinkable credential set is
  meaningfully harder than the password case's fixed-dummy-hash trick.
  Accepted as a known, narrow username-enumeration gap on this one
  endpoint — logged rather than silently left implicit — not worth solving
  ahead of Phase 0's actual UI existing to see how much it matters in
  practice.
- **Challenges are single-use and consumed atomically** (`webauthn_
  challenges.consumed_at`, set inside a transaction that re-checks
  `consumed_at IS NULL` on the UPDATE) — a race between two concurrent
  verify calls for the same challenge can't both succeed; the loser's
  UPDATE affects zero rows once Postgres re-evaluates the WHERE clause
  against the just-committed row. 5-minute challenge TTL.

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
- CI's Postgres service never ran migrations before this slice — harmless
  when `/health`'s `SELECT 1` was the only DB-touching test, but the new
  identity tests need real tables. Fixed by adding
  `npm run db:migrate -w apps/api` to `.github/workflows/ci.yml` between
  `typecheck` and `test`. Verify the next CI run actually picks this up
  (see "Next tasks").
- `wrappedAmkKey` has no real producer yet (see the AMK architecture-decision
  note above) — every caller today, including all tests, sends an arbitrary
  placeholder string. Not a bug, but don't mistake a passing register test
  for evidence that AMK wrapping actually works end-to-end; it only proves
  the server correctly stores-and-never-reads whatever it's given.

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
- **Step-up auth / elevated sessions** (Phase 3+, per SECURITY.md's
  tiering) — the base session built this slice unlocks Low/Medium tier
  modules only; High/Critical need a second, shorter-lived elevated session
  layered on top (re-enter password/passkey + device-local biometric).
  Not designed yet beyond that one sentence in SECURITY.md. Needed before
  any High/Critical-tier module (Phase 3+) ships a write path.
- **Passwordless registration** — today a passkey can only be *added* to an
  identity that already has a password (see the architecture-decision note
  above). Registering with only a passkey, no password, is a real Phase 0
  goal (ARCHITECTURE.md's "password remains a fallback" implies passkey can
  be primary) but needs its own recovery-path thinking first — an identity
  whose only factor is a passkey on a lost device needs a designed way
  back in, not an afterthought.
- **AMK-wrap-via-passkey (PRF/largeBlob extension)** — see the
  architecture-decision note above. Revisit once real client-side AMK
  generation (Next tasks #2) exists and browser/authenticator PRF support
  is worth re-checking.
- **WebAuthn login-options username enumeration** — see the
  architecture-decision note above. A narrow, accepted gap specific to
  `/identity/webauthn/login/options`; password login already closed the
  equivalent hole.

## Next tasks, in order

1. Passkey UI in apps/web (currently a placeholder page) — call
   `navigator.credentials.create()`/`.get()` against the ceremonies built
   this slice. Until this exists, WebAuthn is only exercised by tests and
   the hand-rolled software authenticator, never a real browser/
   authenticator.
2. Real client-side AMK generation in apps/web (WebCrypto: generate the
   Account Master Key, derive a password-based KEK, wrap the AMK, POST the
   wrapped blob to `/identity/register`) — replaces today's opaque
   passthrough with the real mechanism ARCHITECTURE.md describes. Natural
   to build alongside #1 since both need apps/web to stop being a
   placeholder.
3. Passwordless registration — see the future-gaps entry above. Do this
   only after #1/#2 exist to build a UI against, and only with the
   recovery-path question answered first.
4. Step-up auth / elevated sessions for High/Critical tier modules — see
   the future-gaps entry above. Not needed until a Phase 3+ module ships a
   write path, but the base-session/elevated-session split is easier to
   add before any module depends on "one session tier" than after.

## Deployment instructions

None yet — there is no staging or production target. Local-only: see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Security assumptions

- Password hashes (scrypt, salted, no reversible storage) and session-token
  hashes are now stored in the database — but only in local dev and CI's
  ephemeral Postgres containers, both created and destroyed per run/session.
  The hard gate above still blocks any real account existing anywhere else
  (no staging/prod target exists to gate). Nobody's real password or session
  has ever touched this system.
- `.env` is gitignored; `.env.example` has placeholder local-dev credentials
  only (`ident`/`ident`), never used outside `docker-compose.yml`'s local
  container.
- `/health`, `/identity/register`, `/identity/login`, and
  `/identity/webauthn/login/{options,verify}` are intentionally
  public/unauthenticated — they have to be, to bootstrap an identity or a
  session in the first place. `/identity/me`, `/identity/logout`, and
  `/identity/webauthn/register/{options,verify}` require a valid,
  unrevoked, unexpired bearer session token
  (`Authorization: Bearer <token>`); an invalid/missing/expired/revoked
  token gets 401, never a 500 or a silent pass-through. Any new route added
  from Phase 0B onward that isn't itself part of registration/login must
  sit behind `validateSession()` — Phase 0A's old "no second route without
  auth" rule now has a concrete mechanism to enforce it with.
- WebAuthn responses are attacker-controlled JSON off the wire; both verify
  functions wrap the library's verify call in a `.catch` that treats any
  thrown error (malformed base64url, missing fields, decode failures) the
  same as `verified: false`, so a deliberately broken payload can't turn
  into an unhandled 500 — see the architecture-decision notes above for the
  known, narrow exception (login-options username enumeration).

## External approvals pending

None. Nothing in Phase 0A depends on a third party, a regulator, or a
partner — that starts much later (earliest: Phase 5a's financial
aggregator partner, or Phase 10's telecom partners — see ROADMAP.md).
