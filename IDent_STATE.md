# IDent State

**Read this file first, before anything else in this repo.** If the
instruction "read the repository and continue the currently approved
roadmap" doesn't work using only what's below, this file is out of date —
see [OPERATIONS.md](OPERATIONS.md).

Last updated: 2026-08-09 (session 6 — Phase 0B slice: apps/web stops being
a placeholder. Register/login/account pages, real client-side AMK
generation via WebCrypto (PBKDF2 + AES-GCM), passkey registration/login
wired to @simplewebauthn/browser, a new GET /identity/amk-wrap endpoint,
and CORS. Manually verified end to end in a real browser — the first time
any of this identity work has been driven by an actual browser instead of
tests. See "Next tasks" below for what's still not built).

## Current phase

**Phase 0B — Identity Core** (ROADMAP.md Phase 0), in progress. Phase 0A
(ROADMAP.md Era I) is fully done — see its checklist below, unchanged since
session 3.

Done so far: register with a username + password (with a real client-side
Account Master Key generated, wrapped, and sent to the server), log in with
that password (including a second concurrent session — nothing prevents
multiple active sessions per identity, which is what "log in from two
devices" in Phase 0's exit criteria requires), have the AMK fetched back
and unwrapped locally after login, register a passkey on an
already-logged-in identity, log in with that passkey instead of a
password, and log out. All of this now has a real UI in apps/web
(`/register`, `/login`, `/account`) — manually clicked through end to end
in an actual browser: register → account (AMK loaded) → register a passkey
→ log out → log in with password (AMK loaded again) → log in with passkey
instead (AMK correctly *not* available this session, since passkey login
can't unwrap it yet). Password hashes, session tokens, passkey
credentials/signatures, and the AMK wrap/unwrap round-trip are all real —
none of this is stubbed.

Not done: real passkey-derived AMK wrapping (the passkey factor still
sends an honest placeholder, not a working wrap — see below), step-up auth
for High/Critical tier modules, passwordless registration, and any
persistence of the session across a page reload (auth state is deliberately
in-memory only right now).

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
- apps/web: `/register`, `/login`, `/account` pages (Next.js App Router,
  client components), replacing the Phase 0A placeholder. `GET
  /identity/amk-wrap` added to the API (3 new tests, 26 total) so a client
  can fetch its own wrapped AMK back after logging in. `apps/web/lib/amk.ts`
  does real client-side AMK generation/wrap/unwrap with WebCrypto
  (PBKDF2-SHA256 → AES-GCM). CORS added to the API
  (`@fastify/cors`) so the browser can call it cross-origin in dev.
  `packages/shared` gained its first real shared type
  (`IdentitySession`) — the session-shape sharing the Phase 0A notes
  anticipated. Manually verified in a real browser (not just curl/tests):
  register → account (AMK loaded) → register a passkey → log out → log in
  with password (AMK loaded again) → log in with passkey instead (AMK
  correctly unavailable). `npm run typecheck`, `npm run test`, and
  `npm run build` all pass across every workspace with this slice in — no
  new dependency-audit findings from `@fastify/cors`,
  `@simplewebauthn/browser`, or the shared-type change.

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
  an opaque string and never interpreted server-side.** As of this session
  apps/web's password-factor registration sends a *real* wrapped AMK
  (see the AMK-crypto architecture-decision note below); the passkey
  factor still sends a placeholder (see its own note below). The column
  and the "never unwrap server-side" contract were added before either
  producer existed, specifically so retrofitting them after real user data
  exists wouldn't be necessary.
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
- **`GET /identity/amk-wrap` lets an authenticated client fetch its own
  wrapped AMK back out**, defaulting to the `password` factor. This is what
  makes "log in on a second device and still have your AMK" actually work
  — register generates and wraps the AMK once; every subsequent login
  fetches the same wrapped blob and unwraps it locally with the password
  just entered, rather than each device/session minting its own AMK
  (which would defeat the point of a single per-identity key hierarchy).
  Server never sees the unwrapped key at any point in this path.
- **CORS is a single trusted origin, reused from WebAuthn's `ORIGIN`
  config** (`identity/webauthn-config.ts`), not a separate env var —
  the browser origin CORS should trust and the origin WebAuthn ceremonies
  expect are the same value by construction, so one source of truth is
  more correct, not just less config.
- **The AMK crypto (`apps/web/lib/amk.ts`) is real, not a placeholder**:
  PBKDF2-HMAC-SHA256 at OWASP's 2023-minimum 600,000 iterations derives a
  KEK from the password, AES-GCM wraps/unwraps the 32-byte AMK, salt+iv+
  ciphertext travel together as one base64url blob — the same shape the
  server already stores opaquely. This is Phase 0's actual "baseline E2E
  encryption primitives" line item, not a stub to revisit — what's still
  deferred is *using* the AMK to encrypt real module data (nothing needs
  that yet) and the passkey-factor wrap (next point).
- **The passkey factor still can't produce a real AMK wrap — the UI is
  honest about that, not silently broken.** `/account`'s "Register a
  passkey" button sends the literal placeholder string
  `"prf-not-yet-implemented"` as `wrappedAmkKey` rather than fabricating
  ciphertext that looks real but that no passkey can actually unwrap later
  (the WebAuthn PRF extension this needs is still unbuilt — see "Next
  tasks"). A passkey registered this way is fully real for *logging in*;
  it just can't unlock the AMK yet, and the account page's "AMK loaded in
  memory" / "not available this session" status line reflects that
  truthfully after either login path.
- **Auth state (session token + unwrapped AMK) lives in a React context,
  in memory only — nothing persists across a page reload.** Persisting a
  session token safely (localStorage is XSS-exposed, cookies need CSRF
  handling) is a real security design question that Phase 0's placeholder
  UI doesn't need to answer yet; the AMK specifically should almost
  certainly *never* go into any persistent browser storage even once that
  design exists. Logged as a known gap, not an oversight — see "Next
  tasks."
- **No frontend automated tests yet** — no Vitest+Testing-Library harness
  exists for apps/web. This slice was verified by a full manual
  browser click-through (register → passkey → logout → password login →
  passkey login) plus the API's 26 passing tests, which already cover
  every contract these pages call. Adding a real frontend test harness is
  future work, not silently skipped — worth doing once apps/web has enough
  pages that manual click-throughs stop scaling.

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
- The passkey factor's `wrappedAmkKey` has no real producer yet (see its
  architecture-decision note above) — every caller that registers a
  passkey, including apps/web's UI, sends the literal placeholder string
  `"prf-not-yet-implemented"`. The password factor's wrap is real as of
  this session. Don't mistake a passing passkey-registration test for
  evidence that its AMK wrap works end-to-end; it only proves the server
  correctly stores-and-never-reads whatever it's given.

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
  architecture-decision note above. Revisit once browser/authenticator PRF
  support is worth re-checking; apps/web's real client-side AMK generation
  now exists (this session), so this is purely about extending it to a
  second factor, not building the mechanism from scratch.
- **WebAuthn login-options username enumeration** — see the
  architecture-decision note above. A narrow, accepted gap specific to
  `/identity/webauthn/login/options`; password login already closed the
  equivalent hole.
- **Session persistence across a page reload** — see the architecture-
  decision note above. Needs a deliberate security decision (storage
  mechanism, XSS/CSRF trade-offs, whether the AMK specifically should ever
  be re-derivable without re-entering the password), not a quick fix.
- **No frontend automated test harness** — see the architecture-decision
  note above. Worth setting up once apps/web has enough surface that
  manual click-throughs become the bottleneck.

## Next tasks, in order

1. AMK-wrap-via-passkey (WebAuthn PRF extension) — replaces the honest
   `"prf-not-yet-implemented"` placeholder with a real wrap, so passkey
   login can unlock the AMK the same way password login already does. See
   the future-gaps entry above for why this was deferred rather than
   guessed at.
2. Passwordless registration — see the future-gaps entry above. Now that
   real passkey UI exists to build against, the remaining blocker is
   purely the recovery-path design (an identity whose only factor is a
   passkey on a lost device needs a designed way back in).
3. Session persistence across a page reload — see the future-gaps entry
   above. A real security design question (storage mechanism, XSS/CSRF
   trade-offs), not a quick fix.
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
  `GET /identity/amk-wrap` follows the same rule.
- CORS (`@fastify/cors`) restricts the API to a single allowed origin
  (`identity/webauthn-config.ts`'s `ORIGIN`, defaulting to
  `http://localhost:3000` in dev) — not `origin: true`/wildcard. There's
  no cookie-based session for CSRF to exploit (bearer tokens are sent
  explicitly by client code, never attached automatically by the browser),
  so CORS here is about which origins can *read* responses, not about
  protecting a standing credential.
- The unwrapped AMK exists only as a `Uint8Array` in a React context in
  browser memory — it is never written to localStorage, sessionStorage,
  IndexedDB, or any other persistent store, and never leaves the browser
  except as its password-wrapped ciphertext at registration. A page reload
  loses it, which is intentional (see the future-gaps entry on session
  persistence) not a bug to route around by weakening this.
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
