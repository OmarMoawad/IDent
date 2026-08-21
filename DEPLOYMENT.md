# Deploying IDent

**Status: Session 23 completed on 2026-08-21.** Vercel (web), Railway
(API) and Neon (Postgres) were selected on 2026-08-20, and `ident.best` was purchased from
Spaceship the same day for one year through 2027-08-20. Auto-renew and
private WHOIS are on; the registrar account uses a passkey plus TOTP. No
real users may be onboarded before the domain decision window ends on
2026-09-03; changing it before then means deleting test passkeys and
repeating this runbook. This runbook makes the external setup
explicit — external review item 4 named the missing production foundation
as a blocker, and half of that blocker was that no procedure existed to
follow.

Recorded 2026-08-20:

- Railway project `alert-creativity`, service `@ident/api`, **deploys
  `main`** (repointed 2026-08-21, see below); generated URL
  `https://identapi-production.up.railway.app` passed `/health`.

  > **Done 2026-08-21.** Production was served from the feature branch
  > `docs/schedule-ident-best` from 2026-08-20 until the repoint. It now
  > builds and serves `main`, verified from outside rather than from the
  > dashboard: `verify-deployment.mjs --expect-commit` returned **8/8**
  > with `running 4bc51f9c43e3 on main`, and `/health` reports the same
  > commit and branch itself. `docs/schedule-ident-best` has been deleted.
  >
  > **Two things the repoint taught, both worth keeping.**
  >
  > *Changing the source branch does not deploy anything.* Railway kept
  > serving the old container after the setting was changed — the settings
  > screen read `main` while `/health` still reported
  > `docs/schedule-ident-best`, for at least five minutes and across two
  > merges to `main`. A manual **Deploy** was what actually moved it, and
  > it landed in about 20 seconds. The GitHub commit statuses showed the
  > same thing independently: Railway had posted a deploy status on every
  > branch commit and on **no** `main` commit.
  >
  > *So confirm the deploy, never the setting.* This is the entire reason
  > `/health` reports its own commit. "The dashboard says `main`" and
  > "`main` is serving" were different facts here for a measurable
  > interval, and only the second one is the one that matters.
  >
  > Still open: whether **Automatic Deployments** is enabled for the
  > service. Two merges to `main` produced no Railway build without a
  > manual click, so either it is off, or the source change landed after
  > those merges. If it is off, every future merge stops silently short of
  > production.
- Neon project `ident` (`spring-fog-70776779`) is Postgres 18 in Frankfurt;
  the pooled URL is stored only as a masked Railway secret. The free plan's
  six-hour history is not the independent backup required by section 6.
- Vercel project `i-dent-web` deploys `apps/web`; production build
  `5Mk6Cz7yJZNfLaKwBDizgi8F4jj9` completed successfully after setting the
  build command to build `@ident/shared` before `@ident/web`.
- Spaceship contains Railway's `api` CNAME and verification TXT plus
  Vercel's apex A record for `ident.best`. Both custom origins passed external
  HTTPS checks. Railway injects `PORT=8080`; its custom-domain target must be
  8080 (the initial 4000 target produced a useful 502 and was corrected).
- Railway is on a 30-day/$5 trial and displays "Upgrade to keep services
  online." No payment method or paid plan was authorized.
- Google Cloud project `ident-best-prod` is personally owned by
  `okamel1000@gmail.com`, with an External/Testing OAuth app, that address as
  the sole test user, and production origin/callback URLs. The client ID,
  rotated client secret and redirect URI are masked Railway variables; the
  post-change deployment returned a healthy readiness response. Keep the old
  secret enabled only until the first real consent round trip succeeds, then
  disable and delete it in Google Cloud.
- An independent custom-format Postgres dump was uploaded to a private folder
  in Omar's personal Google Drive on 2026-08-21. The archive is 48,607 bytes
  with SHA-256
  `684b3207ae4157da9a926c2a032e0925f30b7806ceaa3c8e44b20a4065443df8`.
  A fresh restore into an isolated Postgres 18 container succeeded in 0.14s
  and recovered 22 user tables (21 application tables plus Drizzle's migration
  table), all 18 migration records, and zero identity/health rows — that dump
  predated `omartest`, confirmed by the 2026-08-21 reconciliation in section 6.
  Google Drive reports the archive as owned by Omar and “Private to you.”
- The owner test identity `omartest` completed passkey registration/login and
  a real Google consent round trip. Enabling Gmail API and Google Calendar API
  in `ident-best-prod` resolved the first callback's expected API-disabled
  error; the second callback returned `gmail=connected`. The obsolete first
  client secret was then disabled and permanently deleted, leaving only the
  verified replacement secret enabled.
- Railway's centralized log explorer showed structured production request and
  response records with timestamps, request IDs, methods, routes, status codes
  and response times. The successful consent exposed OAuth code/state values in
  the callback URL, so this session also added a tested request-log serializer
  rule that retains the callback path but redacts its entire query string.
- Railway rollback restored the previous known-good build and variable
  snapshot, which became Active after 32 seconds; public `/health` then returned
  `status: ok` and `db: ok`. The OAuth-enabled deployment was restored forward,
  became Active after 24 seconds, and passed the same public health check.

Written session 22c (2026-08-16), ported from Receiptless's runbook of
the same name, which has been through a real deployment and a real
rollback rehearsal. Where this says something is *rehearsed*, it means in
this repo, and it says against what.

## Before anything: the hard gate still applies

`IDent_STATE.md`'s standing rule is that **no real account data exists
anywhere beyond local development** until hosting, secrets management and
backups exist. Deploying does not lift that gate; finishing this file's
checklist does.

The external review's verdict — *keep IDent local/private* — stands until
items 1 through 4 of it are done. Sessions 22b and 22c closed 1, 2, 3 and
the parts of 4 that do not need an account. **What is left of 4 is on
this page, and all of it needs Omar.**

## 1. Decisions nobody but Omar can make

| Decision | Why it cannot be defaulted |
| --- | --- |
| **Where the API runs** | Fastify needs a long-lived process. Fly.io, Railway, Render and a plain VPS all work; the choice affects secrets, logs and the rollback mechanism below, so it comes first |
| **Where the web app runs** | Next.js; Vercel is the obvious fit and is what Receiptless already uses |
| **Which Postgres** | Neon (Receiptless uses it) or the host's own. Note Receiptless's finding: six-hour retention on the free tier is thin for data anyone would miss |
| **The domain** | WebAuthn binds credentials to an origin. Changing it later invalidates every passkey — this is not a decision to revisit casually |
| **A real Google OAuth client** | Google Cloud Console. Session 23 cannot start without it |

## 2. Environment variables

Set in the API's environment. **Names are reported by `/health` when
missing; values never are.**

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Pooled connection string |
| `COMMS_TOKEN_ENCRYPTION_KEY` | yes | `openssl rand -base64 32`. The built-in fallback is committed to this repository and is **refused** in any deployed environment (session 22b) |
| `WEBAUTHN_RP_ID` | yes | The bare domain, e.g. `ident.example`. Wrong value = passkeys that register and then silently stop verifying |
| `WEBAUTHN_ORIGIN` | yes | The web app's full origin, e.g. `https://ident.example` |
| `NODE_ENV` | yes | `production`. Or set `IDENT_ENV` — a bare `node dist/index.js` inherits neither |
| `GOOGLE_OAUTH_CLIENT_ID` | if Gmail/Calendar | All three or none — a half-configured connect flow looks like a bug in IDent |
| `GOOGLE_OAUTH_CLIENT_SECRET` | if Gmail/Calendar | |
| `GOOGLE_OAUTH_REDIRECT_URI` | if Gmail/Calendar | Must match Google exactly |
| `ANTHROPIC_API_KEY` | if the assistant | Unset means the assistant is unavailable, never degraded to something else |
| `RATE_LIMIT_ENFORCE` | no | **Leave unset.** `0`/`false` disables every rate limit in the service; `/health` reports it as unsafe |

`readiness.ts` enforces the required rows and the all-or-nothing Google
group, and `/health` reports everything missing **at once** — Receiptless
learned that discovering misconfiguration one variable per redeploy costs
an afternoon.

## 3. Put a proxy in front, and then trust it

Rate limiting keys IP buckets on `request.ip`, which Fastify reports as
the socket address unless the app is built with `trustProxy`. Both
settings are wrong in one of the two possible deployments:

- **Behind a proxy with `trustProxy` off** — every request appears to come
  from the proxy, so one noisy caller throttles everybody.
- **Directly exposed with `trustProxy` on** — any caller can set
  `X-Forwarded-For` and get a fresh identity per request, making every
  IP-keyed limit decorative.

Enable it when, and only when, a proxy is in front and that proxy
overwrites the header. See OPERATIONS.md.

## 4. Migrations are a release step, not a build step

```bash
npm run db:migrate -w apps/api
```

Run it as a deploy step, before the new build takes traffic — never from
the application's own startup path, where two instances would race.

**Migrations must stay additive**, because rolling back is "redeploy the
last good build" and that does not undo a migration. `npm run
check:migrations` enforces it in CI: `DROP COLUMN`, `RENAME`, `ADD COLUMN
NOT NULL` without a default, `DELETE FROM` and `TRUNCATE` all fail the
build unless allowlisted with an argument. Three historical migrations
are allowlisted; each entry says why, and each says the same thing — they
predate any deployment, so there is no released build they could break.

## 5. Verify the deployment from outside

```bash
node scripts/verify-deployment.mjs https://api.ident.example
```

Checks readiness, database reachability, required and unsafe
configuration, that the deployment is new enough to report readiness at
all, that login is actually rate limited, and that the CORS preflight
allows DELETE. It reports **every** check rather than stopping at the
first failure.

**To check *which build* is serving**, pass the commit you expect:

```bash
node scripts/verify-deployment.mjs https://api.ident.best \
  --expect-commit $(git rev-parse origin/main)
```

`/health` reports the commit the running process was built from — Railway
injects `RAILWAY_GIT_COMMIT_SHA` into every deployment, and the field is
omitted rather than guessed when no platform provides one. This is the
check a provider dashboard cannot give you: the dashboard says which
build *succeeded*, which stops being the same thing the moment a redeploy
fails and leaves the previous container serving. Without an
`--expect-commit` the check is skipped rather than passed vacuously.

Evidence labels in this runbook are deliberately narrower than a bare
"verified": **verified now/live** means the named command was run against
the named target now; **CI/repository verified** means an automated result is
tied to code or a CI run; and **operator verified** means private
infrastructure, credentials or artifacts were observed by an operator. A
historical result is not present-tense live health merely because it passed.

Four things it lists as MANUAL and does not check: backups and a
rehearsed restore, logs actually arriving, a rehearsed rollback, and a
real Google consent. A green run does not imply any of them — the script
says so in its own output, because "verified" that quietly excludes the
hard parts is worse than no claim.

**CI/repository verified (historical):** a 2026-08-16 local rehearsal passed
7/7 automated checks. That proves the script, not a deployment.
**Operator verified (historical):** the 2026-08-20 run against
`https://api.ident.best` passed 7/7 automated checks (readiness, database,
complete/safe configuration, rate limiting and DELETE CORS). Neither result
is **verified now/live** health; rerun the command above to make that claim.
Backup/restore was then operator-verified on 2026-08-21 as recorded below.
Logs, rollback and real Google consent remain open and are not implied by the
green result.

## 6. Backups

The first independent backup and restore rehearsal completed on 2026-08-21.
`pg_dump` produced a custom-format, no-owner/no-privileges archive from Neon;
the archive was validated with `pg_restore --list`, uploaded outside Neon to a
private personal Google Drive folder, and restored into an isolated local
Postgres 18 container. The restored database contained 22 user tables, 18/18
migration records, and zero identity and health rows. Restore time
for the database operation was 0.14s; allow a provisional **RTO of 30 minutes**
for archive retrieval, operator setup and verification. Until an automated
schedule exists, the provisional **RPO is 24 hours** and requires a daily dump.

> **Operator verified (historical, 2026-08-21): the archive was reported as a
> faithful copy of production.**
>
> `scripts/reconcile-backup.mjs` reported **RECONCILED**: production holds
> **1 identity** — `omartest` — and it survives a dump and restore, with
> every counted table (`identities`, `system_health_checks`, Drizzle's
> migration ledger) matching on both sides. Fresh archive SHA-256:
> `240e91466820ca8028c1ce7d3fa282399a97db32123602ea24770680e3c69f13`.
> The production access and fresh dump are private artifacts, so this result
> is not reproducible from this repository alone.
>
> So the Session 23 rehearsal's zero was the **benign** explanation of the
> two: the dump was taken before `omartest` registered, not from a
> database the API does not write to. Worth stating plainly, because the
> two possibilities were indistinguishable from the evidence recorded at
> the time, and only one of them left this section's claim standing.
>
> **What actually changed is the strength of the claim, not the outcome.**
> Session 23 proved the schema and the migration history round-trip.
> This proves rows do — which is the thing a backup exists to do, and the
> thing a restore verified against an empty dataset could never show. The
> gate is closed on evidence now rather than on a green run that happened
> to be empty.

**Initial Session 23 archive evidence (pre-`omartest`):** these details refer
to the earlier empty-data rehearsal archive, not the later reconciliation
archive. The later reconciliation archive is identified by the
`240e9146…c69f13` checksum in the operator-verified result above.

- File: `ident-production-2026-08-21.dump`
- Size: 48,607 bytes (Drive displays 47 KB)
- SHA-256: `684b3207ae4157da9a926c2a032e0925f30b7806ceaa3c8e44b20a4065443df8`
- Independent storage: private folder in Omar's personal Google Drive,
  reported by Drive as “Private to you”

The ongoing requirements remain:

- An **independent** dump, somewhere that is not the database provider —
  provider-side point-in-time recovery does not survive the account, a
  billing lapse, or a mistaken project deletion.
- A **restore that has actually been performed**, not just configured. An
  untested backup is a belief about a file.
- **RPO and RTO written down as numbers**, not implied by "we have
  backups".

Next, copy `scripts/backup-database.mjs` and
`scripts/verify-backup-restore.mjs` from Receiptless and automate the daily
dump. They are provider-agnostic `pg_dump`/`pg_restore` wrappers. Repeat a
restore rehearsal at least monthly and after any backup-process change.

## 7. Rollback

The procedure is **redeploy the last known-good build**, which section 4
is what makes safe.

**Rehearsed 2026-08-21 in Railway production.** Rolling back to the previous
known-good build restores both its build and its variable snapshot. Railway
marked that deployment Active after 32 seconds; the operator-observed interval
through the public `/health` verification was 50 seconds. The endpoint returned
`status: ok`, `db: ok`, and no missing or insecure configuration. Rolling
forward to the OAuth-enabled deployment took 24 seconds to Active and passed
the same public health check. Use **60 seconds** as the measured recovery target
for this deployment shape, and always restore forward after a rehearsal when
the older snapshot intentionally lacks newer optional integration variables.

**The known-good target drifts, and that is the part to watch.** The
snapshot rehearsed against predates the OAuth variables, so rolling back to
it today would restore a build that cannot complete a Google consent — it
would pass `/health` and fail the feature. A rollback target is only good
for the configuration it was captured with, so **after every variable
change, the last known-good deployment is the one taken after that
change**, not the one this rehearsal used. Re-establish it as part of
changing a variable rather than discovering it mid-incident.

## 8. What is still missing, honestly

Session 23's production-like gate is closed: hosting, masked provider secrets,
external health verification, centralized logs, independent backup plus
restore, rollback plus forward recovery, and real Google consent have all been
exercised and recorded.

Remaining operational follow-up is explicit rather than part of that gate:

- **Session 23a is closed:** Railway was repointed to `main`, and the backup
  discrepancy was reconciled. These are not remaining actions; the historical
  Railway evidence is in IDent_STATE.md's opening current-status block, the
  backup evidence is in section 6, and section 5 has the verifier command for
  a fresh live claim.
- Railway is still on a 30-day/$5 trial. Choose and authorize a paid plan before
  relying on it beyond the trial; this session did not authorize payment.
- Railway's log retention still holds the callback query strings written
  *before* the redaction landed, so the authorization codes and state values
  from the consent rehearsal are in that history. Both are single-use and
  long expired, and the client secret they were issued against was rotated
  and deleted the same session, so there is nothing live in them — recorded
  because "we fixed the logging" and "the logs are clean" are different
  claims, and only the first is true.
- Railway retains/searches stdout logs, but no proactive uptime alert currently
  pages the owner. Add an external health monitor before onboarding anyone else.
- Automate the daily independent dump required by the provisional 24-hour RPO.
- Google OAuth remains External/Testing with one owner test user. Verification
  and production audience expansion are later launch work, not needed for the
  private production rehearsal.
