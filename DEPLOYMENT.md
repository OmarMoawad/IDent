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

- Railway project `alert-creativity`, service `@ident/api`, deploys branch
  `docs/schedule-ident-best`; generated URL
  `https://identapi-production.up.railway.app` passed `/health`.

  > **Needs Omar, before that branch is merged.** Production is served
  > from a feature branch, not `main`. Merging its PR and deleting the
  > branch — the normal end of every session here — removes the ref
  > Railway builds from, and the failure would show up as production
  > going stale or failing its next deploy rather than as anything
  > red in GitHub.
  >
  > **The order, and it is the whole point** — `main` is behind this branch
  > by the whole of Session 23, so repointing before merging would roll
  > production backwards, and deleting before repointing would leave it
  > with nothing to build:
  >
  > 1. Merge the PR, so `main` carries Session 23. Do not take GitHub's
  >    offer to delete the branch yet.
  > 2. Repoint the Railway service to `main`.
  > 3. Verify the `main` build is the one *serving* (section 5).
  > 4. Then delete the branch.
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
  table), all 18 migration records, and zero identity/health rows — a count
  that section 6 flags as unreconciled, since `omartest` should have been in
  that dump. Google Drive reports the archive as owned by Omar and “Private to you.”
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

Four things it lists as MANUAL and does not check: backups and a
rehearsed restore, logs actually arriving, a rehearsed rollback, and a
real Google consent. A green run does not imply any of them — the script
says so in its own output, because "verified" that quietly excludes the
hard parts is worse than no claim.

**Rehearsed 2026-08-16 against a local API: 7/7 automated checks passed.**
That proves the script, not the new deployment. The production run itself is
now recorded: **2026-08-20 against `https://api.ident.best`, 7/7 automated
checks passed** (readiness, database, complete/safe configuration, rate
limiting and DELETE CORS). Backup/restore was then completed manually on
2026-08-21 as recorded below. Logs, rollback and real Google consent remain
open and are not implied by the green result.

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

> **Unresolved, and it weakens the claim above — needs Omar.** The zero
> identity count does not agree with the rest of this session. The owner
> test identity `omartest` completed passkey registration and a real
> Google consent round trip against *this* production deployment, as
> recorded in section 4 — so a dump of that database should have carried
> one identity, not none. Either the dump was taken before `omartest`
> existed, or it was taken from a different database than the API writes
> to. Both are worth knowing, and the second is much worse.
>
> Until it is settled, **this rehearsal proves the schema and the
> migration history round-trip, and nothing about data.** A restore
> verified against an empty dataset cannot show that rows survive it,
> which is the thing a backup exists to do.
>
> To settle it, one command:
>
> ```
> DATABASE_URL='<production url>' node scripts/reconcile-backup.mjs --keep-dump ./backups
> ```
>
> It counts `identities`, `system_health_checks` and Drizzle's migration
> ledger in production, takes a fresh custom-format dump, restores it into
> a throwaway `postgres:18` container, counts again, and prints a verdict
> rather than numbers to interpret. Every statement it runs against
> production is a `SELECT`, the connection string comes from the
> environment rather than argv so it stays out of shell history, and the
> container is removed afterwards.
>
> Three outcomes, and only one closes the gate:
>
> - **RECONCILED** — counts agree and are non-zero. Replace this note with
>   the numbers and the checksum it prints.
> - **MISMATCH** — the archive is not a faithful copy of production. This
>   section's claim fails outright.
> - **MATCHED, but zero identities** — the counts agree on nothing. If
>   `omartest` should exist and does not, `DATABASE_URL` points somewhere
>   the API does not write, and the same wrong database was dumped. That is
>   the explanation this note exists to rule out, so do not record a pass
>   on it.
>
> Rehearsed against the local dev database on 2026-08-21 before being
> handed over: 9,564 identities and 18 migration records round-tripped, so
> the script's happy path is exercised rather than assumed.

Archive evidence:

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

- **Repoint the Railway service from `docs/schedule-ident-best` to `main`
  before that branch is merged or deleted.** See section 2 — this is the one
  follow-up that can take production down rather than merely leave it
  unimproved.
- Railway is still on a 30-day/$5 trial. Choose and authorize a paid plan before
  relying on it beyond the trial; this session did not authorize payment.
- **Reconcile the backup's zero identity count with `omartest` existing in
  production**, and re-dump if they disagree. See section 6.
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
