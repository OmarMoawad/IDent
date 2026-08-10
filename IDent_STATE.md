# IDent State

**Read this file first, before anything else in this repo.** If the
instruction "read the repository and continue the currently approved
roadmap" doesn't work using only what's below, this file is out of date —
see [OPERATIONS.md](OPERATIONS.md).

Last updated: 2026-08-10 (session 9 — Phase 0B slice: the recovery-code
factor, unblocking passwordless registration per session 8's "next tasks"
note. A server-generated, 20-character (100-bit) recovery code is the
"its own wrapped copy, its own factor" recovery path ARCHITECTURE.md's
key-hierarchy note calls for: `POST /identity/recovery/generate`
(authenticated) mints one, hashes it the same way as a password (reusing
`identity/password.ts`'s scrypt implementation, which was already generic)
into a new `recovery_credentials` table (migration
`0004_medical_bill_hollister.sql`, one row per identity — regenerating
replaces it, invalidating the old code immediately), and returns the
plaintext once. `PUT /identity/recovery/wrap` then stores the client's
AMK wrap for factor "recovery" — reusing `account_master_key_wraps`
(no new wrap table needed: a recovery code, like a password, is one
interchangeable secret per identity, unlike per-credential passkeys).
`POST /identity/recovery/login` mirrors password login exactly, including
the timing-safe dummy-hash trick against username enumeration. The
existing `GET /identity/amk-wrap?factor=recovery` route needed zero
changes — its generic `else` branch already handled any factor besides
"passkey". apps/web: `/account` gained a "Generate a recovery code" button
(shows the code once, wraps the AMK with it via the existing
`amk.ts` PBKDF2/AES-GCM functions if the AMK is loaded, an honest "can't
unlock yet" message if not — same pattern as the PRF-unsupported
placeholder); `/login` gained a collapsible recovery-code login form.
`npm run typecheck`, `npm run test` (40 passing, up from 30), and
`npm run build` all pass across every workspace; the new migration
applied clean against a live local Postgres; the full HTTP contract
(generate → wrap → recovery-login → fetch-wrap, plus wrong-code and
no-session-token rejections) was re-verified with curl against the live
dev API. **Not browser-click-through-verified this session** — the
Chrome browser-automation tool couldn't render `localhost`/`127.0.0.1`
pages in this environment (external sites worked fine; every local dev
URL came back "Frame with ID 0 is showing error page" across two tabs and
both hostnames), unlike sessions 5-8 which all got a real click-through.
Omar should click through register → generate recovery code → log out →
log in with the recovery code → confirm the AMK unlocks, the same way he
verified the PRF work in session 8, before this is considered as solid as
the rest of Phase 0B. Also added a ROADMAP.md Phase 1 line (at Omar's
request, mid-session): AI-assisted importance filtering that's
*negotiated*, not silent — every deprioritized item stays visible, the
user can override any call or the rule behind it, and the bar is tunable
per source/contact. See "Next tasks" below for what's still not built.

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
password, log out, stay logged in across a page reload (session token only
— the AMK re-locks and needs a password or passkey re-entry to unlock),
and now unwrap the AMK using a passkey's real WebAuthn PRF secret instead
of a placeholder — both at login (single ceremony) and via a new "Unlock
with passkey" button on /account. When a passkey can't produce a real PRF
secret (unsupported authenticator, or the AMK was locked at registration
time), apps/web stores and surfaces an honest, distinguishable placeholder
instead of fabricating ciphertext nothing could unwrap later, generate a
server-issued recovery code, wrap the AMK with it, log back in using only
that code if password and passkey are both unavailable, and unwrap the AMK
with it too. All of this has a real UI in apps/web (`/register`, `/login`,
`/account`), including the PRF ceremony and the recovery-code flow — the
PRF work was click-through-verified in a real browser in session 8; this
session's recovery-code work was not (see header for why) and still needs
that pass. Password hashes, session tokens, passkey credentials/
signatures, and all three AMK wrap/unwrap paths (password, passkey/PRF,
recovery code) are real — none of this is stubbed.

Not done: passwordless registration (the recovery-path blocker is now
resolved — see "Next tasks") and step-up auth for High/Critical tier
modules.

### 0A checklist status

This table is a snapshot of Phase 0A's own infra checklist, frozen as of
session 3 when Phase 0A finished — it does **not** track Phase 0B's
progress (see "Current phase" above and "Completed components" below for
that). A few rows below were left describing the Phase 0A-era state after
Phase 0B had already outgrown them; fixed here since a future session
skimming just this table would otherwise get a false "nothing built yet"
read.

| Item | Status |
|---|---|
| Monorepo (npm workspaces: `apps/api`, `apps/web`, `packages/shared`) | Done |
| Backend skeleton (Fastify + TypeScript) | Done as Phase 0A infra. Since outgrown: `/identity/*` and `/identity/webauthn/*` are real domain routes now — see "Completed components." |
| Web client skeleton (Next.js App Router) | Done as Phase 0A infra. Since outgrown: `/register`, `/login`, `/account` are real pages now, not a placeholder — see "Completed components." |
| Database wiring (Postgres + Drizzle migrations) | **Verified against a live DB** — `docker compose up -d`, `db:generate`, `db:migrate` all run clean; `/health` returns `db: "ok"`. |
| Automated tests | Done as Phase 0A infra (one test, `/health`). Since outgrown: 30 tests across identity/session/WebAuthn — see "Completed components." |
| CI/CD | **Verified on GitHub, repeatedly** — every push since Phase 0A's scaffold (including all of Phase 0B's slices) has a green `gh run watch` on `main`, most recently the session-persistence commit; this session's PRF work has not yet been pushed (see "Next tasks"). |
| Dev/staging/production environments | Not started. Only local dev exists (docker-compose Postgres + `npm run dev:*`). No staging/prod hosting target chosen yet. Not a Phase 0B blocker. |
| Logging | Partial — Fastify's built-in pino logger is on by default (see the request logs in `npm run test` output). No log aggregation/shipping anywhere. |
| Monitoring | Not started. |
| Backups | Not started — no real database with real data yet, so nothing to back up. |
| Migration system | Done — Drizzle + drizzle-kit wired up. Since outgrown: `src/db/schema.ts` now has real domain schema too (identity/session/WebAuthn tables, migrations `0001`–`0002`), not just the original infra-proving `system_health_checks` table. |
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
- Session persistence: `apps/web/lib/auth-context.tsx` now persists the
  session token to `sessionStorage` and rehydrates it via `GET
  /identity/me` on app load; `/account` gained an unlock form (password →
  `GET /identity/amk-wrap` → `unwrapAmk`) for re-deriving the AMK after a
  reload, since the AMK itself is never persisted. No backend changes were
  needed — this reuses the existing `/identity/me` and `/identity/amk-wrap`
  endpoints. Manually verified in a real browser: register → reload
  (stays logged in, AMK shows locked) → unlock with password (AMK loads)
  → log out → reload `/account` directly (correctly redirected to
  `/login`, not a stale session). `npm run typecheck` and `npm run build`
  pass across every workspace; the API's 26 tests are unaffected (no
  backend changes this slice) and still pass.
- Passkey-derived AMK wrapping (WebAuthn PRF extension): new
  `passkey_amk_wraps` table (migration `0003_easy_redwing.sql`), one row
  per WebAuthn credential (not per identity+factor like
  `account_master_key_wraps`) since each passkey has its own PRF secret.
  `getRegistrationOptions` now requests `extensions: { prf: {} }` (probe
  support only); `getAuthenticationOptions` requests
  `extensions: { prf: { eval: { first: <salt> } } }` so a real login
  ceremony evaluates PRF in the same user gesture as the signature check.
  The PRF salt (`webauthn-config.ts`'s `getPrfSaltBase64Url`) is SHA-256 of
  a fixed public label, independently recomputed by `apps/web/lib/prf.ts`
  rather than shared as a hardcoded byte array, so the two copies can't
  drift. New `GET /identity/amk-wrap?factor=passkey&credentialId=...`
  contract (credentialId required — 400 without it; ownership re-checked
  via `findCredentialByCredentialId`, so one identity can't read another's
  wrap by guessing a credentialId — ownership isolation has a dedicated
  test). `apps/web/lib/prf.ts` derives the AES-GCM key via HKDF-SHA256 from
  the PRF output (empty HKDF salt — the PRF output is already fresh,
  high-entropy, per-credential IKM, per RFC 5869 §2.2); registration runs a
  two-step create()-then-get() ceremony (create()-time PRF results aren't
  reliable across browsers, per the WebAuthn PRF extension's own guidance)
  and stores an honest placeholder (`prf-unsupported` or
  `amk-locked-at-registration`, distinguishable from real ciphertext) when
  the authenticator can't produce a secret or the AMK wasn't loaded at
  registration time. `/account` gained an "Unlock with passkey" button
  alongside the existing password-unlock form; `/login`'s passkey path now
  unwraps the AMK in the same ceremony as login, instead of always staying
  locked. 8 new/changed tests (30 total in the API workspace): PRF
  extension present in both options responses, a full register→fetch-wrap
  round trip, cross-identity ownership isolation, and the
  missing-credentialId (400) / unknown-credentialId (404) contract.
  `npm run typecheck`, `npm run test`, and `npm run build` all pass across
  every workspace; the new migration was applied clean against a live
  local Postgres, and the HTTP-level contract (extensions in both options
  responses, the amk-wrap round trip, the 400/404 cases) was re-verified
  with curl against the live dev API, not just vitest. **Manually
  click-through-verified in a real browser (Touch ID) by Omar**: register
  → real PRF wrap on passkey registration → log out → passkey login alone
  unlocks the AMK → reload (re-locks) → "Unlock with passkey" unlocks it
  again. Caught and fixed one real bug along the way — see this file's
  header for the `eval.first` bytes-vs-base64url-string mismatch.
- Recovery-code factor: new `recovery_credentials` table (migration
  `0004_medical_bill_hollister.sql`), `POST /identity/recovery/generate`
  (authenticated, mints and stores a hashed code, returns the plaintext
  once), `PUT /identity/recovery/wrap` (authenticated, stores the client's
  AMK wrap under the existing `account_master_key_wraps` table with
  `factor: "recovery"`), and `POST /identity/recovery/login` (mirrors
  `/identity/login`'s shape and its timing-safe dummy-hash username-
  enumeration defense exactly). `apps/api/src/identity/recovery-code.ts` is
  new: `generateRecoveryCode()` produces a `XXXXX-XXXXX-XXXXX-XXXXX`
  Crockford-base32-ish code (~100 bits of entropy, ambiguous characters
  I/L/O/U excluded since it's meant to be handwritten and retyped) and
  `normalizeRecoveryCode()` strips hyphens/whitespace/case before hashing
  or verifying — mirrored client-side in `apps/web/lib/recovery-code.ts` so
  the same normalized string is what gets hashed server-side and what
  derives the AMK-wrap KEK client-side. 10 new tests (40 total in the API
  workspace): generate→wrap→recovery-login→fetch-wrap round trip,
  regenerating invalidates the previous code, wrong code / unknown
  username / never-generated-a-code all reject, hyphens/case are ignored
  on login, both new endpoints reject a missing session token, plus 3 unit
  tests for the code generator's format/uniqueness. apps/web: `/account`
  gained a "Generate a recovery code" button (shows the code once with a
  save-it warning; wraps the AMK with it immediately if the AMK is loaded,
  otherwise an honest "generated but can't unlock the vault yet" message —
  same pattern as the PRF-unsupported placeholder, no fabricated
  ciphertext); `/login` gained a collapsible "Log in with a recovery code"
  form. `npm run typecheck`, `npm run test`, and `npm run build` all pass
  across every workspace; the new migration applied clean against a live
  local Postgres; the full HTTP contract was re-verified with curl against
  the live dev API (see header for why this substituted for a browser
  click-through this session).

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
- **The passkey factor now produces a real AMK wrap when the authenticator
  supports the WebAuthn PRF extension and the AMK was loaded at
  registration time — falling back to an honest, distinguishable
  placeholder otherwise, never fabricated ciphertext.** `/account`'s
  "Register a passkey" flow checks `clientExtensionResults.prf.enabled`
  after `create()`, then runs a local-only `get()` ceremony
  (`getPrfOutputForNewCredential` in `apps/web/lib/prf.ts`) to pull the
  actual secret and wrap the AMK with it via HKDF+AES-GCM. If the
  authenticator lacks PRF support, `wrappedAmkKey` is the placeholder
  `"prf-unsupported"`; if PRF is supported but the AMK wasn't loaded in
  memory when the passkey was registered, it's `"amk-locked-at-registration"`
  — both distinguishable from real ciphertext and both surfaced honestly in
  the UI's status message, not silently swallowed. A passkey registered
  under either placeholder is fully real for *logging in*; it just can't
  unlock the AMK until re-registered with the AMK loaded. See the
  "Completed components" entry above for the full mechanism (per-credential
  wraps, the two-ceremony registration pattern, and why). **Not yet
  browser-click-through-verified** — see this file's header.
- **The session token persists across a reload via `sessionStorage`; the
  AMK never persists at all, by design.** `sessionStorage` was chosen over
  `localStorage` (indefinite, cross-tab, higher exposure window) and over
  cookies (would mean adding CSRF handling and a cookie-based auth path
  alongside the existing bearer-token one — a bigger architecture change
  than this slice needs). `sessionStorage` dies with the tab and is never
  written to disk the way `localStorage` is, which is a meaningfully
  smaller exposure surface for the same convenience. The AMK is refetched
  and re-unwrapped on demand instead (see the unlock-flow note below) —
  this is the same "locked vault, unlock with password" pattern password
  managers use, not a workaround. On mount, the token is validated against
  `GET /identity/me` rather than trusted blindly — an expired/revoked
  token gets cleared, not silently kept around.
- **`/account`'s unlock flow re-derives the AMK by calling the existing
  `GET /identity/amk-wrap` + `unwrapAmk` — no new backend endpoint.** Needed
  after any reload, and also currently the only way to get the AMK loaded
  after a passkey login (since passkey login can't unwrap it directly —
  see the passkey-AMK-wrap note above). One mechanism serves both cases.
- **No frontend automated tests yet** — no Vitest+Testing-Library harness
  exists for apps/web. This slice was verified by a full manual
  browser click-through (register → passkey → logout → password login →
  passkey login) plus the API's 26 passing tests, which already cover
  every contract these pages call. Adding a real frontend test harness is
  future work, not silently skipped — worth doing once apps/web has enough
  pages that manual click-throughs stop scaling.
- **The recovery code is long-lived, not single-use or auto-rotated on
  successful login.** Reusing it as many times as needed (like a password)
  was chosen over invalidating it after one login, because rotation would
  require the client to immediately regenerate-and-rewrap in the same
  authenticated flow right after a recovery login — real extra scope this
  slice didn't need to take on when "regenerate manually whenever you want
  a fresh code" (the existing "Generate a recovery code" button) already
  covers the same threat model at the cost of one more manual step. Logged
  as a deliberate deferral, not an oversight — see the known-gaps log below
  for when it'd be worth revisiting.
- **Recovery code generation is a two-step HTTP exchange
  (`POST .../generate` then `PUT .../wrap`), not one call like password
  registration.** Password registration sends password+wrappedAmkKey
  together because the client already knows the password before calling.
  Here the client can't wrap anything with a secret it doesn't have yet —
  the server has to generate and return the code first. Same
  opaque-passthrough convention as every other factor once the second call
  happens: the server never sees the unwrapped AMK either way.

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
- The WebAuthn/PRF ceremony was manually click-through-verified in a real
  browser this session (see this file's header) — but only on one platform
  authenticator (Touch ID on Omar's Mac, via whichever browser he tested
  in). The automated test suite's software authenticator has no PRF/
  hmac-secret simulation (see `identity/test-support/software-
  authenticator.ts`), so PRF derivation is only ever exercised by real
  hardware, never by CI. Untested: security keys, Windows Hello, and
  browsers/authenticators that don't support PRF at all (the
  `PRF_UNSUPPORTED_PLACEHOLDER` fallback path is implemented but has not
  been observed firing against a real non-PRF authenticator).
- CI logs a deprecation warning (not a failure) that `actions/checkout@v4`
  and `actions/setup-node@v4` target Node 20, which GitHub is forcing onto
  Node 24 runners in the meantime. Bump both actions to their Node
  24-native major version next time `.github/workflows/ci.yml` is touched
  for another reason — not urgent enough to justify a dedicated pass.

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
  be primary). The recovery-path blocker this was waiting on is now built
  (session 9's recovery-code factor) — see "Next tasks" for what's left:
  designing the actual create-identity-with-passkey-only ceremony and
  deciding whether generating a recovery code should be mandatory (not just
  offered) during that flow, since a passwordless identity with no recovery
  code yet would have no way back in at all if the one passkey is lost
  before one is ever generated.
- **Recovery code is long-lived, not single-use** — see the
  architecture-decision note above for the reasoning. Worth revisiting if
  real usage shows people never manually regenerate after using one, since
  that would mean a once-exposed code (e.g. read over someone's shoulder)
  stays valid indefinitely.
- **WebAuthn login-options username enumeration** — see the
  architecture-decision note above. A narrow, accepted gap specific to
  `/identity/webauthn/login/options`; password login already closed the
  equivalent hole.
- **No frontend automated test harness** — see the architecture-decision
  note above. Worth setting up once apps/web has enough surface that
  manual click-throughs become the bottleneck. Now three sessions running
  on manual verification alone (register/login/passkeys, then session
  persistence) — worth revisiting this trade-off if a fourth frontend
  slice is about to ship the same way.

## Next tasks, in order

Do not start Phase 1 (or any later phase) before these are done — per an
external review of this repo (2026-08-09): the identity/key foundation
everything else builds on should be solid before more surface area sits on
top of it, and "solid" specifically means real passkey-based AMK unlock,
not just passkey login, plus the recovery-path and step-up items below.
(Real passkey-based AMK unlock was completed and click-through-verified in
session 8 — see this file's header. The recovery-path design/build was
completed in session 9, but not yet browser-click-through-verified — see
this file's header for why, and do that verification before treating it
as done the way session 8's PRF work is.)

1. Browser-click-through-verify session 9's recovery-code flow (register →
   generate a recovery code → log out → log in with only the recovery code
   → confirm the AMK unlocks) — this environment's browser-automation tool
   couldn't reach localhost this session, so only curl-against-the-live-API
   and vitest have verified it so far.
2. Passwordless registration — see the future-gaps entry above. Now that
   real passkey UI (PRF-based AMK wrapping, session 8) and a real recovery
   path (recovery-code factor, session 9) both exist, the remaining work is
   the create-identity-with-passkey-only ceremony itself, plus deciding
   whether generating a recovery code should be a mandatory step of that
   flow rather than a separately offered one (see the future-gaps entry).
3. Step-up auth / elevated sessions for High/Critical tier modules — see
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
  loses it, which is intentional (see the session-persistence
  architecture-decision note above) — the account page's unlock flow is
  the sanctioned way back, not a bug to route around by weakening this.
  The session *token* is the one thing that does persist (`sessionStorage`
  only, tab-lifetime, revalidated against `GET /identity/me` on load —
  see the same note).
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
