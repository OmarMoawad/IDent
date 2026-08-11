# IDent State

**Read this file first, before anything else in this repo.** If the
instruction "read the repository and continue the currently approved
roadmap" doesn't work using only what's below, this file is out of date —
see [OPERATIONS.md](OPERATIONS.md).

Last updated: 2026-08-11 (session 14 — Gmail OAuth connection flow, the
second slice of **Phase 1: Communications Hub** — see session 13's
paragraph below for the schema foundation this builds on. Built to the
same-day session-13 review's pre-connector checklist point by point:

- **Real Google Cloud OAuth credentials** — Omar created the project,
  consent screen (External, `gmail.readonly` scope only, test users),
  and OAuth client himself; walked through step by step, since this is a
  real third-party account only he can create. The pasted client ID/secret
  had corrupted characters twice (a dropped hyphen, then an i/l mixup) —
  each was verified against Google's own token endpoint before trusting
  it: POSTing a deliberately invalid authorization code and checking
  whether Google's error was `invalid_client` (credentials themselves
  wrong) vs. `invalid_grant` (credentials fine, code rejected as
  expected) — the second response is what confirmed the final pasted
  values were genuine, without ever completing a real OAuth flow or
  exposing the secret anywhere but this local `.env`.
- **Encrypted token storage with real authenticated encryption**:
  `comms/token-encryption.ts`, AES-256-GCM, iv+authTag+ciphertext packed
  into one base64url blob (same convention as `apps/web/lib/amk.ts`'s
  wrap format) — a tampered blob fails to decrypt instead of silently
  returning corrupted plaintext, same discipline as the WebAuthn verify
  functions. Uses session 13's previously-unused `encrypted_token_data`
  column — no schema change needed for this part.
- **Access and refresh tokens handled/rotated separately**: packed into
  one encrypted JSON payload for storage, but `getActiveGmailAccessToken`
  treats them as distinct fields with distinct lifecycles — a refresh
  updates `accessToken`/`expiresAt` in place and only replaces
  `refreshToken` if Google actually rotates it on that call.
  `ACCESS_TOKEN_REFRESH_BUFFER_MS` (2 minutes) means a token is refreshed
  *before* it's actually expired, not after a request already failed.
- **Minimum scope**: `https://www.googleapis.com/auth/gmail.readonly`
  only (`comms-config.ts`'s `GMAIL_SCOPE`).
- **OAuth `state` validated**: new `oauth_state_challenges` table
  (migration `0009_sturdy_dark_phoenix.sql`) — see its comment in
  schema.ts for why this needs its own state-keyed lookup rather than
  reusing identity/webauthn's identity-keyed challenge pattern (the
  callback is an anonymous browser redirect with no bearer token; `state`
  is the *only* thing correlating it back to who started the flow).
  Single-use, short-lived (10 minutes), same atomic
  consume-or-null shape as `webauthn-store.ts`'s `consumeChallenge`.
- **Token-refresh tests**: `gmail-service.test.ts` proves a
  near-expiry token gets refreshed and persisted, a still-valid one
  doesn't trigger a refresh call, and a rotated refresh token is what
  gets stored (checked via decrypting the raw stored blob, not just
  observing the returned access token).
- **Real disconnect/revocation**: `disconnectGmailSource` calls
  Google's revoke endpoint (best-effort — Google being unreachable
  shouldn't block clearing IDent's own copy) and then **clears the
  stored tokens outright** (`clearConnectedSourceTokens`, from session
  13's review) rather than only flipping a status label — a subsequent
  `getActiveGmailAccessToken` call correctly fails with
  `ConnectedSourceNotConnectedError` afterward.

Testability without a real browser consent flow (which only a human can
complete): `comms/google-oauth-client.ts` defines a `GoogleOAuthClient`
interface the real Google-calling implementation and every
`gmail-service.ts` function both take as an injectable parameter
(defaulting to the real singleton) — `comms/test-support/
fake-google-oauth-client.ts` is the injected double tests use, the same
role `identity/test-support/software-authenticator.ts` plays for WebAuthn.
32 new tests (101 total in the API workspace): encryption round-trip and
tamper-rejection, OAuth state issuance/consumption/expiry/replay/race,
connect/refresh/disconnect service-layer behavior via the fake client, and
route-level auth-gating/validation/error-redirect tests that never call
Google for real (kept deliberately separate from the fake-client tests —
routes have no way to inject a fake client through HTTP, so route tests
only cover paths that never reach `googleOAuthClient`). New routes: `POST
/identity/connections/gmail/start`, `GET .../callback`, `POST
.../:sourceId/disconnect`, registered in `app.ts`. `npm run typecheck`,
`npm run test`, and `npm run build` all pass across every workspace; the
migration applied clean against a live local Postgres. No web UI yet —
that's session 4 ("Unified inbox UI") per the Phase 1 cadence; for now
`POST /identity/connections/gmail/start` has to be called directly (curl
or a REST client) to get a real authorization URL to visit.

Also from session 13 — first slice of **Phase 1:
Communications Hub**, now that Phase 0B is closed — see session 12's
paragraphs below for how that gate closed. Per "Next tasks"' session-1
scope: schema + connected-source data model only, no OAuth, no HTTP routes,
no UI yet. New tables `connected_sources` (identity_id, provider, status,
an `encrypted_token_data` column nothing writes to yet) and `messages`
(the unified shape every future connector normalizes into — subject/
snippet/body/participants/occurredAt/isRead, denormalized `identityId` so
identity-scoped queries are a single indexed lookup, not a join through
`connected_sources`) — migration `0007_exotic_ultimates.sql`. Both tables
stay in the existing `db/schema.ts` file for now (migration-history
convenience under the Phase 0-2 modular-monolith note in ARCHITECTURE.md);
the module boundary ARCHITECTURE.md's "Domain services" calls for is
enforced at the code layer instead — new `comms/store.ts` only ever
queries these two tables plus the identities.id foreign key every domain
is allowed to anchor to, never another domain's internal tables. A unique
index on `(sourceId, externalId)` makes `upsertMessage` idempotent, so a
future re-sync of the same source updates content rather than creating
duplicate rows — and deliberately leaves `isRead` alone on re-sync
(re-importing shouldn't silently flip something the user already read
back to unread, or vice versa). No HTTP layer yet — nothing external to
call it from until a real OAuth connector exists (session 2 of the Phase 1
cadence) — so `comms/store.test.ts` exercises the store functions
directly against a live Postgres, the same way Phase 0A's first commit
proved migrations worked before anything called them over HTTP. 8 new
tests (68 total): insert/find round trip, cross-identity isolation for
both connected sources and messages (including a direct by-id lookup, not
just the list query), upsert idempotency and content-refresh-on-resync,
isRead surviving a resync, and newest-first ordering. `npm run typecheck`,
`npm run test`, and `npm run build` all pass across every workspace; the
migration applied clean against a live local Postgres.

**Same-day follow-up (2026-08-11, still session 13):** an external review
found two real gaps in the schema above, both worth closing before
session 14's Gmail connector starts writing real data. (1) The comment
claiming `findMessagesByIdentity`'s `identityId` filter was "a single
indexed lookup" was wrong — no index on `messages.identityId` or
`connected_sources.identityId` actually existed yet. Fixed:
`messages_identity_occurred_at_idx`, a composite index on
`(identityId, occurredAt)` matching that function's actual query shape
(equality filter + sort) in one index scan, and
`connected_sources_identity_id_idx` for `findConnectedSourcesByIdentity`.
(2) More importantly: nothing tied a message's `identityId` to the
identity that actually owns its `sourceId` — `messages.identityId` and
`messages.sourceId` were two independently-valid foreign keys with no
relationship to each other, so a bug in a future sync worker could insert
`{identityId: Alice, sourceId: <Bob's connected source>}` and both
individual foreign keys would still pass. Fixed at the database level, not
just by convention: `connected_sources` gained a
`(id, identityId)` unique constraint, and `messages.sourceId` now has a
**composite** foreign key against that pair instead of a plain
single-column one — `(sourceId, identityId)` must match a real
`connected_sources` row's `(id, identityId)`, making the mismatched
combination impossible to insert, not just untested. One new regression
test (69 total) proves inserting a message with another identity's
`sourceId` throws. Required reordering one migration statement
(`0008_cold_tenebrous.sql`) by hand — drizzle-kit generated the new
composite foreign key *before* the unique constraint it depends on, which
Postgres rejects ("no unique constraint matching given keys"); the unique
constraint now runs first. `npm run typecheck`, `npm run test`, and
`npm run build` all pass across every workspace; the migration re-applied
clean against a live local Postgres.

Also from session 12 — step-up auth / elevated sessions,
per the pre-Phase-1 gate's last remaining item, confirmed as this
session's starting task by a 2026-08-11 external review — see "Next
tasks" below for the requirement list it sharpened SECURITY.md's one
sentence into). Built exactly to that list: a distinct `elevatedUntil`
field on the existing `sessions` row (migration
`0006_great_the_anarchist.sql`), not a second session/token; a 5-minute
elevation window (`session.ts`'s `ELEVATION_TTL_MS`), shorter than the
24h base session; elevation obtained by re-entering password, passkey, or
recovery code — `identity/service.ts`'s `elevateWithPassword`/
`elevateWithRecoveryCode` and `identity/webauthn-service.ts`'s
`elevateWithPasskeyAssertion` reuse the exact same verify paths
(`verifyPassword`, the recovery-code hash check, `verifyAuthenticationResponse`)
login already used, via a shared `verifyAssertion` extracted from
`verifyAuthentication` rather than a second WebAuthn-verify copy; no
client-controlled trust-tier claim — elevation status is read fresh from
the DB on every request; enforcement is a Fastify `preHandler` hook
(`identity/elevation.ts`'s `requireElevatedSession`), not a per-handler
inline check a route could ship without; **the session's bearer token is
now rotated on every successful elevation** (see the follow-up paragraph
below for why — this replaces an earlier, weaker "same token, just
re-checked" design). Resolved the session's
one open design question (a synthetic route vs. an isolated untested
primitive) by building a demo-only `GET /identity/demo/high-tier-secret`
guarded by the hook, since no real High/Critical-tier module exists yet
to protect (Phase 3+) and the requirement list explicitly asks for a real
browser click-through, which needs something real to click. New
`identity/elevation-routes.ts` (`POST /identity/elevate/password`,
`/recovery`, `/webauthn/options`, `/webauthn/verify`, plus the demo
route) registered in `app.ts`; `GET /identity/me` now also returns
`elevatedUntil`. 10 new tests (59 total): non-elevated/missing/invalid
session rejected from the demo route, all three factors elevate
correctly and reject when wrong, an elevated demo-route call actually
succeeds, an *expired* elevation is rejected via `vi.useFakeTimers`
(proving a real expiry check, not a static flag), and a logged-out
session can't be elevated. apps/web: `/account` gained a "Step-up
verification" section (password re-entry → elevate, plus a "View
protected demo data" button exercising the guarded route end to end).
`npm run typecheck`, `npm run test`, and `npm run build` all pass across
every workspace; the migration applied clean against a live local
Postgres. **Not yet browser-click-through-verified**: this session's
sandboxed dev servers and the Chrome browser-automation tool's network
turned out to be on different loopback interfaces (`curl localhost:3000`
succeeded from the sandbox while the browser tool got a network error on
the same URL) — the same class of gap sessions 9 and 10 hit before
session 11 closed it manually. Needs the same treatment: Omar
click-through-verifying step-up in a real browser next session, guided
step by step. Once that's done, the external review's pre-Phase-1 gate is
fully satisfied and Phase 1 can start — see "Next tasks" below.

**Same-day follow-up (2026-08-11, still session 12):** a second external
review — asked to check the session-12 work itself, not just re-read this
file — independently verified the CI run, the tests, and the backend
implementation, and flagged one real design gap the "replay-resistant by
construction" claim above had understated: elevation was a pure attribute
of the *existing* session row, so a bearer token stolen **before**
elevation would silently start passing `requireElevatedSession` the
moment the legitimate owner elevated that same session — no
re-authentication of the attacker's own required, since nothing about the
token itself changed. Fixed the same session: every `elevate*` function
(`elevateWithPassword`, `elevateWithRecoveryCode`,
`elevateWithPasskeyAssertion`) now also rotates the session's bearer
token — `store.ts`'s `elevateSessionById` sets a new `tokenHash` in the
same update as `elevatedUntil`, and the elevate endpoints return the new
raw token in the response body (`{elevatedUntil, sessionToken}` instead of
just `{elevatedUntil}`). The old token stops matching any session the
instant elevation succeeds — not just for elevated routes, for
everything, since it's the same bearer credential. Standard OWASP
session-management guidance (regenerate the session identifier on a
privilege change), applied rather than left as a known gap. apps/web's
`/account` step-up form now switches `auth.sessionToken` to the rotated
value on a successful elevate (`setAuth` already persists whichever token
it's given to `sessionStorage`, so this needed no persistence-layer
change). One new test (`identity/elevation.test.ts`, 60 total): the
pre-elevation token is confirmed dead (401, not just un-elevated) after a
successful elevation, and the rotated token is confirmed to actually work.
The three existing elevation-success tests were updated to capture and use
the rotated token for their post-elevation assertions, since the original
token they'd been reusing is now invalid by design. `npm run typecheck`,
`npm run test`, and `npm run build` all pass across every workspace.
That same review also ran `gitleaks detect` (full history, both this repo
and Receiptless) as a reproducible check on top of the session's earlier
manual secret-pattern grep before either repo went public — both came back
clean, no leaks found.

**Real-browser click-through, completed 2026-08-11 (still session 12):**
Omar ran it himself against `npm run dev:api` + `npm run dev:web` on his
own machine, since the Chrome browser-automation tool's sandboxed network
still couldn't reach `localhost` on a second attempt this same day (see
above — a stable environment split, not a fluke). Register → `/account`'s
"View protected demo data" correctly denied (403, not elevated) →
re-entered password under "Step-up verification" → elevate succeeded,
button now succeeds (200) → **reloaded the page and it still worked** —
confirms elevation is genuinely server-side truth (`sessions.elevatedUntil`
in Postgres), not something that only worked because client state hadn't
reset → waited past the 5-minute `ELEVATION_TTL_MS` window and the button
correctly denied again (403), confirmed against the API's own request log
(timestamps ~305s apart, matching the 300s TTL almost exactly). No bugs
found this pass — unlike sessions 9-11's click-throughs, which each caught
something vitest/curl couldn't, this one held up clean on the first real
try. **This closes the external review's pre-Phase-1 gate.** Phase 1
(ROADMAP.md — Communications Hub) can start; see "Next tasks" below for
how it's being sequenced, the same session-by-session way Phase 0B was.

Also from session 11 (kept here as history, superseded as "current" by
the above): real browser click-through verification of sessions 9 and
10's work, done by Omar himself, guided step by step. This is the pass
both of those sessions flagged as outstanding (their Chrome
browser-automation tool couldn't reach `localhost` in that environment).
It surfaced **two real bugs neither vitest nor curl-against-the-live-API
had caught**, both now fixed and covered by regression tests:

1. **`PUT /identity/recovery/wrap` was silently unreachable from the
   browser.** `app.ts`'s CORS registration (`app.register(cors, { origin:
   [ORIGIN] })`) never listed `methods`, and `@fastify/cors` defaults to
   `GET,HEAD,POST` only — so the browser's preflight `OPTIONS` for `PUT`
   got back an `access-control-allow-methods` header that didn't include
   `PUT`, and the browser correctly refused to send the real request. The
   fetch failed with a generic network-level error (not an HTTP response),
   which apps/web's `request()` doesn't recognize as an `ApiError`, so it
   surfaced as the generic "Could not generate a recovery code." message —
   accurate as far as it went, but not diagnostic. Neither `curl` (no CORS
   enforcement at all) nor vitest's `app.inject()` (bypasses the HTTP/CORS
   layer entirely) can ever catch this class of bug — only a real browser
   preflight does. Fixed: `methods: ["GET", "HEAD", "POST", "PUT"]` added
   explicitly in `app.ts`.
2. **Passkey login was completely broken for passwordless identities.**
   `store.ts`'s `findIdentityByUsername` — shared by password login *and*
   both passkey-login steps (`getAuthenticationOptions`/
   `verifyAuthentication` in webauthn-service.ts) — did an `INNER JOIN` on
   `password_credentials`. A passwordless identity (session 10) has no row
   there at all, so the join silently excluded it from every lookup,
   including passkey login — its *only* login path. Surfaced as "No
   account with that username" for a username that definitely existed.
   Every existing passkey-login test registered a password identity first
   and added a passkey second, so this never got exercised against a
   passwordless-only identity until a real click-through tried it. Fixed:
   `leftJoin` instead of `innerJoin`, `passwordHash` now typed
   `string | null`; `loginWithPassword`'s existing `?? getDummyHash()`
   fallback already handled a null hash correctly with zero code changes
   needed there — a passwordless identity now correctly 401s on a password
   login attempt via the same timing-safe dummy-hash path, instead of
   crashing or misbehaving.

2 new regression tests added (49 total, up from 47): passkey login
succeeding for a passwordless-registered identity, and a password-login
attempt against one correctly rejecting instead of crashing. `npm run
typecheck`, `npm run test`, and `npm run build` all pass across every
workspace. **Both the recovery-code factor (session 9) and passwordless
registration (session 10) are now genuinely browser-click-through-verified
end to end**, all 9 steps: password register → generate recovery code →
log out → log in with only the recovery code (AMK unlocks) → passwordless
register (mandatory recovery-code screen shown, not skippable) → log out →
log in with the passkey alone → log out → log in with that identity's
recovery code alone (AMK unlocks). This closes the one item sessions 9 and
10 both left open — see "Next tasks" below, which now only has step-up
auth remaining before the external review's pre-Phase-1 gate is fully
satisfied.

See "Completed components" and "Architecture decisions" below for the full
session 9 (recovery-code factor) and session 10 (passwordless
registration) writeups — unchanged by this session except for the two
fixes above. Also from session 9: a ROADMAP.md Phase 1 line (at Omar's
request) for AI-assisted importance filtering that's *negotiated* with the
user rather than silent.

**Also from session 10, before this session's browser verification
(documentation only, no code):** captured Omar's decision on merging
Receiptless
(`/Users/Omar/receiptless`, a separate, real, actively-developed digital-
receipt project — previously untracked in this repo's memory) into the
IDent ecosystem. Decision: loosely-coupled integration, not a repo/
codebase merge — Receiptless keeps its own repo, its own roadmap, and
likely its own brand ("Receiptless — by IDent"); IDent becomes its
identity authority via `ownerSubjectId` → `identity_id`, resolved through
a new scoped/pseudonymous per-relationship identifier (not today's single
`@username`) rather than one correlatable ID handed to every merchant.
Written up as a new "Receiptless" entry in ROADMAP.md (positioned right
after Phase 1, deliberately not given a phase number — it's an external
product, not an IDent-authored dependency), a pointer in ARCHITECTURE.md's
Domain services and Data model note sections, and two new entries in this
file's future architecture gaps log below (the scoped-alias design itself,
and the Receiptless integration's two real prerequisites — Receiptless's
own multi-user auth and IDent's scoped-alias system — neither of which
exists yet on either side). Nothing to build from this yet; it's
documented intent, not a task.

## Current phase

**Phase 0B — Identity Core** (ROADMAP.md Phase 0) is **done** — step-up
auth's real-browser click-through completed 2026-08-11 (see this file's
header), closing the external review's pre-Phase-1 gate. Phase 0A
(ROADMAP.md Era I) has been done since session 3 — see its checklist
below. **Phase 1 — Communications Hub** (ROADMAP.md) is now in progress:
session 13 laid the schema/data-model foundation (`connected_sources`,
`messages`), session 14 (see this file's header) built the real Gmail
OAuth connector on top of it — connect, refresh, disconnect, all
encrypted, tested, and backed by real (verified) Google Cloud credentials.
No UI yet — see "Next tasks" below for the full session-by-session
sequencing and what's next (session 3 of that list: message sync, pulling
real messages from a connected Gmail account into the `messages` table).

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
that code if password and passkey are both unavailable, unwrap the AMK
with it too, and now also create a brand-new identity from nothing but a
passkey — no password required, with a recovery code minted automatically
as a mandatory part of that same flow (see this file's header). All of
this has a real UI in apps/web (`/register`, `/login`, `/account`),
including the PRF ceremony, the recovery-code flow, and passwordless
registration — the PRF work was click-through-verified in session 8, and
the recovery-code and passwordless-registration flows were verified in
session 11 (which also found and fixed two real bugs neither flow's
automated tests had caught — see this file's header). Password hashes,
session tokens, passkey credentials/signatures, and all three AMK
wrap/unwrap paths (password, passkey/PRF, recovery code) are real — none
of this is stubbed.

Step-up auth (session 12) is done, tests and all, including the
real-browser click-through (see this file's header) — the last item on
the pre-Phase-1 gate an external review set in session 8. Phase 0B is
closed; Phase 1 is next.

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
- Passwordless registration: new `passwordless_registration_challenges`
  table (migration `0005_aromatic_zzzax.sql`), keyed by username rather
  than identity_id since no identity exists until the ceremony verifies —
  see this file's header for the full sequencing design (opaque random
  WebAuthn userID, all-or-nothing `createIdentityWithPasskey` transaction,
  username claimed only at verify). `POST /identity/webauthn/register-
  identity/options` + `.../verify` are the two new routes;
  `verifyPasswordlessRegistration` (webauthn-service.ts) reuses
  `recovery-code.ts` and `password.ts`'s `hashPassword` exactly the way
  `generateRecoveryCode` (service.ts) does, so the mandatory recovery-code
  hash minted here is indistinguishable in the DB from one minted through
  the authenticated `/identity/recovery/generate` flow — same table, same
  hashing, same verification path at recovery-login time. apps/web:
  `/register` gained a collapsible "Register with just a passkey, no
  password" form that generates the AMK client-side, does the passkey
  ceremony (real PRF wrap or the honest `prf-unsupported` placeholder,
  same logic as account/page.tsx's "Register a passkey"), then — before
  ever calling `setAuth`/navigating — wraps the AMK with the returned
  recovery code, PUTs that wrap, and shows the code on its own
  save-it-now screen. 7 new tests (47 total in the API workspace): the
  full create→login round trip including the mandatory recovery code,
  that code alone logging back in with zero other factors, an abandoned
  ceremony not squatting the username (proven by successfully
  password-registering the same username afterward), unknown/replayed/
  invalid-username rejections, and the username-taken 409 at verify time.
  `npm run typecheck`, `npm run test`, and `npm run build` all pass across
  every workspace; the new migration applied clean against a live local
  Postgres; the options endpoint's validation was re-verified with curl
  against the live dev API (verify needs a real WebAuthn attestation,
  which only vitest's software authenticator can produce against these
  same route handlers and the same live Postgres — see header).
- Session 11 bug fixes (found via the manual browser click-through
  sessions 9/10 had been waiting on — see header for full detail): (1)
  `app.ts`'s CORS registration now explicitly lists
  `methods: ["GET", "HEAD", "POST", "PUT"]` — `@fastify/cors`'s
  unconfigured default (`GET,HEAD,POST`) was silently blocking the
  browser's preflight for `PUT /identity/recovery/wrap`, invisible to both
  curl (no CORS enforcement) and vitest's `app.inject()` (bypasses HTTP
  entirely). (2) `store.ts`'s `findIdentityByUsername` now `leftJoin`s
  `password_credentials` instead of `innerJoin`ing it, with `passwordHash`
  typed `string | null` — the inner join had silently excluded every
  passwordless identity from both passkey-login steps
  (`getAuthenticationOptions`/`verifyAuthentication` in
  webauthn-service.ts, which resolve the username through this same
  function), so passkey login — the *only* login path for a passwordless
  identity — was completely broken for exactly the identities session 10
  introduced. `loginWithPassword`'s existing `record?.passwordHash ??
  getDummyHash()` fallback already handled a null hash correctly with zero
  changes needed. 2 new regression tests (49 total): passkey login
  succeeding for a passwordless-registered identity, and a password-login
  attempt against one correctly 401ing instead of crashing.
  `npm run typecheck`, `npm run test`, and `npm run build` all pass across
  every workspace. **Both fixes were confirmed live in the browser by
  Omar** (not just re-run against vitest) — he retried the exact failing
  step after each fix and it succeeded — and all 9 steps of both flows
  (recovery-code factor and passwordless registration) are now genuinely
  browser-click-through-verified end to end, closing the gap sessions 9
  and 10 both left open.
- Step-up auth / elevated sessions (session 12 — see this file's header
  for the full design writeup): new `sessions.elevated_until` column
  (migration `0006_great_the_anarchist.sql`), `POST /identity/elevate/
  password`, `/recovery`, `/webauthn/options`, `/webauthn/verify`, and a
  demo-only `GET /identity/demo/high-tier-secret` guarded by a new Fastify
  `preHandler` hook (`identity/elevation.ts`'s `requireElevatedSession`).
  Every elevate call also rotates the session's bearer token (same-day
  follow-up after a second external review — see this file's header) —
  the elevate endpoints return `{elevatedUntil, sessionToken}`, and the
  old token is dead the instant elevation succeeds. 11 new tests (60 total
  in the API workspace) in `identity/elevation.test.ts`. `npm run
  typecheck`, `npm run test`, and `npm run build` all pass across every
  workspace; the migration applied clean against a live local Postgres.
  apps/web's `/account` gained a "Step-up verification" section that
  switches to the rotated token on a successful elevate. **Real-browser
  click-through-verified by Omar, 2026-08-11 — see this file's header.**
  This closed the external review's pre-Phase-1 gate; Phase 0B is done.
- **Phase 1 — Communications Hub, session 13 (see this file's header for
  the full design writeup): schema/data-model foundation only.** New
  `connected_sources` and `messages` tables (migrations
  `0007_exotic_ultimates.sql`, `0008_cold_tenebrous.sql`), new
  `comms/store.ts` (insert/find connected sources and messages, all
  identity-scoped; `upsertMessage` is idempotent on `(sourceId,
  externalId)`). Same-day follow-up (see header): a composite foreign key
  now ties `messages.sourceId` to `connected_sources`' `(id, identityId)`
  pair, so a message's `identityId` can never mismatch the identity that
  actually owns its `sourceId` — not just a plain single-column FK plus
  hope; indexes added on both tables' `identityId` columns
  (`messages_identity_occurred_at_idx` is composite with `occurredAt`,
  matching the actual query shape). No OAuth, no HTTP routes, no UI yet —
  `comms/store.test.ts` exercises the store layer directly against a live
  Postgres. 9 new tests (69 total in the API workspace), including a
  regression test proving a cross-identity `sourceId` is rejected. `npm run
  typecheck`, `npm run test`, and `npm run build` all pass across every
  workspace; the migration applied clean against a live local Postgres.
- **Phase 1 — Communications Hub, session 14 (see this file's header for
  the full design writeup): Gmail OAuth connection flow, real credentials,
  built to the session-13 review's pre-connector checklist point by
  point.** New `oauth_state_challenges` table (migration
  `0009_sturdy_dark_phoenix.sql`), `comms/token-encryption.ts` (AES-256-GCM),
  `comms/google-oauth-client.ts` (real client + injectable interface),
  `comms/gmail-service.ts` (connect/refresh/disconnect, all
  ownership-checked), `comms/gmail-routes.ts` (`POST /identity/
  connections/gmail/start`, `GET .../callback`, `POST
  .../:sourceId/disconnect`). 32 new tests (101 total in the API
  workspace) via `comms/test-support/fake-google-oauth-client.ts` (same
  role `identity/test-support/software-authenticator.ts` plays for
  WebAuthn) plus route-level auth/validation tests that never call
  Google. `npm run typecheck`, `npm run test`, and `npm run build` all
  pass across every workspace; the migration applied clean against a
  live local Postgres. No UI yet (session 4).

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
  wraps, the two-ceremony registration pattern, and why). Browser-
  click-through-verified in session 8 (Touch ID) — this note was stale
  (still said "not yet" long after that), fixed while closing out session
  12's own click-through note elsewhere in this file.
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
- **Passwordless registration's username is claimed inside the same
  transaction that verifies the passkey, not at the options step.** The
  alternative — insert the identity+username first, run the ceremony
  against that real identity_id, delete it on failure — was rejected
  because "delete it on failure" has to handle every abandonment path
  (browser closed, user declines the Touch ID prompt, tab crashes, network
  drop before verify), and missing even one of those leaves a username
  permanently squatted by an identity nobody can log into (no password, no
  verified passkey). A dedicated username-keyed challenge table
  (`passwordless_registration_challenges`) that nothing else references
  sidesteps the cleanup problem entirely: if verify never happens, the row
  just expires and the username was never claimed.
- **WebAuthn's userID for the options step is an opaque `randomUUID()`,
  not the username or any value that gets reused later.** The existing
  identity-bound `getRegistrationOptions` uses `identityId` as userID
  because that identity already exists; here nothing exists yet, and
  WebAuthn best practice is that userID shouldn't carry recognizable PII
  (some authenticators/credential managers persist it). Nothing needs to
  read this handle back — the real, permanent `identity_id` is minted
  separately, inside `createIdentityWithPasskey`, once verification
  succeeds.
- **A recovery code is mandatory for passwordless registration, not
  optional the way it is for password/passkey identities.** Session 9 left
  this as an open question (see its future-gaps entry); resolved here in
  favor of mandatory because a passwordless identity's *only* other factor
  is the single passkey just registered — skip the recovery code and
  losing that one device means the identity is unrecoverable, full stop.
  `createIdentityWithPasskey`'s transaction mints the hash unconditionally
  (no code path creates a passwordless identity without one), and apps/web
  makes it structurally impossible to skip the UI step too: `setAuth`/
  navigation don't run until after the recovery-code screen is shown and
  acknowledged, on its own screen rather than folded into a success
  toast that's easy to miss.

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

- **`messages`' current columns (subject/snippet/body/participants) will
  become a lossy archive once a real provider connector lands** — fine as
  the *normalized* shape for Session 13's foundation-only scope (matches
  Receiptless's own "one canonical object, capture-channel-agnostic"
  principle), but Gmail and any later provider carry more than that:
  thread ID, labels/folders, MIME type, attachments, sender/reply-to,
  provider-side metadata, and a sync cursor/history ID for incremental
  sync. Don't design a provider/raw-metadata envelope now — no driver
  exists yet to know its real shape — but when session 14+ actually syncs
  real Gmail messages, give it somewhere to keep what doesn't fit the
  normalized columns instead of silently dropping it.
- **Scoped/pseudonymous per-relationship identifiers** (Receiptless
  integration, and any future merchant/carrier/institution-facing flow) —
  today's Data model note (ARCHITECTURE.md) has exactly one public,
  correlatable identifier (`@username`) besides the opaque internal
  `identity_id`. Handing that same `@username` to every external party
  defeats the point once there are enough of them to cross-reference (a
  supermarket and a carrier shouldn't be able to trivially confirm they
  share a customer). Needs a real design: how a scoped alias is minted per
  relationship, how it's resolved back to `identity_id` (Identity Core
  only, never the counterparty), and its lifecycle (revocable? one per
  merchant forever, or rotatable?). Not designed yet — first concrete
  driver is Receiptless's merchant-facing checkout (see ROADMAP.md's
  "Receiptless" entry), so revisit when that integration actually starts,
  not before.
- **Receiptless integration itself** — see ROADMAP.md's "Receiptless"
  entry for the full shape (separate repo stays separate, `ownerSubjectId`
  pattern, no monorepo merge). Two real prerequisites block it that
  neither repo has yet: Receiptless's own multi-user auth (its Phase 1 —
  today it's one shared vault, no accounts) and IDent's scoped-alias
  system (the gap directly above). Purely a documented future intent as
  of 2026-08-10 — nothing to build from this entry yet.
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
- ~~**Step-up auth / elevated sessions**~~ — built and unit-tested as of
  session 12 (real-browser click-through still pending, see "Next tasks"),
  device-local biometric excluded since Phase 3 enrollment doesn't exist
  yet. See this file's header and "Completed components" above for the
  full design. The only thing still deferred to Phase 3+ is a *real*
  High/Critical-tier route to actually guard with it — today's demo route
  is a stand-in (see "Next tasks").
- ~~**Passwordless registration**~~ — done as of session 10. A passkey no
  longer needs a password-holding identity to attach to;
  `/identity/webauthn/register-identity/{options,verify}` create one from
  scratch, with a mandatory recovery code minted in the same transaction.
  See this file's header and "Completed components"/"Architecture
  decisions" above for the full design.
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

**The pre-Phase-1 gate (external review, 2026-08-09) is now fully
satisfied.** Real passkey-based AMK unlock (session 8), recovery-path and
passwordless registration (sessions 9-10, click-through-verified session
11), and step-up auth (session 12, click-through-verified 2026-08-11 — see
this file's header) are all done, tested, and browser-verified. Phase 0B
is closed. **Phase 1 — Communications Hub** (ROADMAP.md) starts now.

Phase 1's ROADMAP.md entry is five bullets (unified inbox, contact cards,
calendar+reminders, a read-only AI assistant, negotiated importance
filtering) but each is real, multi-day work — the same situation
Receiptless's own Phase 1 was in before it got broken into a
session-by-session cadence (see `/Users/Omar/receiptless/
RECEIPTLESS_STATE.md`). Sequenced the same way here, foundation before
UI before intelligence, mirroring how Phase 0B itself was built
(schema-only sessions before auth sessions before UI sessions):

1. ~~**Communications Hub schema + connected-source data model**~~ — done
   in session 13 (see this file's header and "Completed components"
   above): `connected_sources` and `messages` tables, `comms/store.ts`,
   8 tests. No UI, no real OAuth yet — that's next.

2. ~~**OAuth connection flow, first provider (Gmail)**~~ — done in
   session 14 (see this file's header and "Completed components" above),
   built against every item of the session-13 review's pre-connector
   checklist: real Google Cloud credentials (Omar's own, verified against
   Google's token endpoint before trusting them), AES-256-GCM token
   encryption, access/refresh tokens handled separately with a refresh
   buffer, `gmail.readonly`-only scope, `state`-validated callback,
   token-refresh tests, and a real disconnect that clears stored tokens
   outright. `POST /identity/connections/gmail/start`, `GET .../callback`,
   `POST .../:sourceId/disconnect`.

3. **Message sync. This is the next session to do.** Pull recent messages
   from a connected Gmail account (via `getActiveGmailAccessToken` from
   session 14 — it already handles refreshing an expired token, so this
   session shouldn't need to touch that logic), normalize into `messages`
   rows via session 13's schema (`upsertMessage` is already idempotent on
   `(sourceId, externalId)`, so re-syncing is safe to call repeatedly).
   Real Gmail API calls, not fakeable the way OAuth token exchange was —
   this session should follow session 14's own pattern: wrap the Gmail
   API surface behind a small injectable interface (a `GmailApiClient` or
   similar) so `comms/test-support/` gets a fake for it too, the same way
   `FakeGoogleOAuthClient` let session 14 be tested without hitting
   Google's real OAuth endpoints. **Open design question to resolve at the
   start of that session, before writing code** (per RECEIPTLESS_STATE.md's
   own convention of flagging these rather than improvising mid-session):
   background job or on-demand endpoint — decide which before writing
   code. On-demand is simpler to ship and test; a background job is what
   "daily-driver inbox aggregator" actually needs long-term — likely
   on-demand first, background job as a fast-follow once the sync logic
   itself is proven. Also decide: how far back does an initial sync reach
   (all mail is not realistic), and what happens to a source stuck in
   `status: "connected"` whose access token turns out to be permanently
   unusable (revoked outside IDent, e.g. from Google's own account
   settings) — should a sync failure eventually flip it to an error
   status a UI can surface, not just fail silently forever.

4. **Unified inbox UI.** List/read/search messages across whatever
   sources are connected — the first user-facing surface of Phase 1.
   Exit-criteria-relevant: this is what makes IDent "daily-driver usable
   as a notification/inbox aggregator" per ROADMAP.md's own bar.

5. **Contact cards.** Unify contacts surfaced by connected sources into
   one record per person — not calling/communications routing yet (that's
   Phase 2+/Phase 10), just a unified read model.

6. **Calendar + reminders.** Likely a second OAuth scope on the same
   Gmail/Google connection from Session 2 (Google Calendar), or a second
   provider — decide when this session starts, informed by whichever
   provider Session 2 actually picked.

7. **Basic AI assistant (paid tier, the monetization wedge — see
   BOOTSTRAP.md).** Read-only Q&A over the user's own inbox/calendar/
   contacts. **Needs Omar**: which LLM provider/API — not decided
   anywhere in this repo yet, don't default to one silently.

8. **AI-assisted importance filtering (paid).** The most design-heavy
   item in Phase 1's ROADMAP.md entry — re-read that entry's constraints
   before starting: negotiated not silent, nothing auto-hidden or
   auto-deleted, per-source/contact tunable, defers to the user's stated
   preference over its own guess. Sequenced last because it's the
   highest-judgment, most easily-gotten-wrong piece — build it against a
   working inbox (Sessions 1-4), not before one exists.

Re-baseline this list once Session 1 actually starts — providers,
sync-strategy, and AI-assistant choices made along the way may reorder or
reshape sessions 2-8, the same way Receiptless's own cadence already got
revised once mid-flight.

**Delete the synthetic demo route** (`GET /identity/demo/high-tier-secret`,
`identity/elevation-routes.ts`) once a real High/Critical-tier module
(Phase 3+, not this list) ships a route that can carry the "prove
elevation is enforced" burden instead. Not urgent, not part of the Phase 1
sequence above — do it alongside whichever Phase 3+ slice adds the first
real High/Critical route.

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
  `GET /identity/amk-wrap` follows the same rule. `POST /identity/elevate/
  {password,recovery,webauthn/options,webauthn/verify}` also sit behind
  `validateSession()` (a valid *base* session is required just to attempt
  step-up) plus their own factor re-verification; `GET
  /identity/demo/high-tier-secret` sits behind the stricter
  `requireElevatedSession()` (session 12) instead — a valid base session
  alone isn't enough, it must also be currently elevated.
- `POST /identity/connections/gmail/start` and `POST .../:sourceId/
  disconnect` (session 14) sit behind `validateSession()` like every other
  post-Phase-0B route, with `disconnect` additionally checking the
  connected source's `identityId` matches the caller's before touching it.
  `GET .../callback` is the one intentional exception — it can't carry a
  bearer token (it's an anonymous top-level redirect from Google, not a
  fetch from apps/web), so its equivalent gate is the single-use,
  10-minute `oauth_state_challenges` row the `state` parameter resolves
  to. Gmail OAuth tokens are encrypted at rest with AES-256-GCM
  (`comms/token-encryption.ts`) before ever reaching
  `connected_sources.encrypted_token_data`; `.env`'s real Google Cloud
  client ID/secret follow the same gitignored-never-committed rule as
  everything else in that file, and `COMMS_TOKEN_ENCRYPTION_KEY` currently
  falls back to a fixed dev-only key (same convention as
  `identity/webauthn-config.ts`'s dev defaults) — set a real one before
  the hard gate above is ever lifted.
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
