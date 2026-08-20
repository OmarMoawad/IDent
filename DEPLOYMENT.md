# Deploying IDent

**Status: Session 23 deployment is live on provider and custom hostnames;
the production gate is not closed.** Vercel (web), Railway
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

Four things it lists as MANUAL and does not check: backups and a
rehearsed restore, logs actually arriving, a rehearsed rollback, and a
real Google consent. A green run does not imply any of them — the script
says so in its own output, because "verified" that quietly excludes the
hard parts is worse than no claim.

**Rehearsed 2026-08-16 against a local API: 7/7 automated checks passed.**
That proves the script, not the new deployment. The production run itself is
now recorded: **2026-08-20 against `https://api.ident.best`, 7/7 automated
checks passed** (readiness, database, complete/safe configuration, rate
limiting and DELETE CORS). The four MANUAL rows remain open and are not
implied by the green result.

## 6. Backups

Same shape as Receiptless, which has scripts for this and has rehearsed a
restore. IDent has neither yet, and the reason is not laziness: without a
hosting decision there is no database to back up and no machine to run
the job on.

When there is one, the requirements are already known and are not
negotiable:

- An **independent** dump, somewhere that is not the database provider —
  provider-side point-in-time recovery does not survive the account, a
  billing lapse, or a mistaken project deletion.
- A **restore that has actually been performed**, not just configured. An
  untested backup is a belief about a file.
- **RPO and RTO written down as numbers**, not implied by "we have
  backups".

Copy `scripts/backup-database.mjs` and `scripts/verify-backup-restore.mjs`
from Receiptless when the time comes; they are provider-agnostic
`pg_dump`/`pg_restore` wrappers.

## 7. Rollback

The procedure is **redeploy the last known-good build**, which section 4
is what makes safe.

It has **not been rehearsed** — Receiptless's rehearsal measured 42
seconds to recovery, and that number is Receiptless's, not IDent's.
Rehearsing it here is part of the first real deploy, not something to
discover during an incident. Write the measured number into this section
when it happens.

## 8. What is still missing, honestly

Everything in this list is external review item 4, and none of it can be
closed by an agent:

- **No hosting.** Nothing is deployed anywhere.
- **No secrets management** beyond "environment variables in a host's
  dashboard" — which is adequate for one person and worth revisiting
  before it is not.
- **No monitoring or alerting.** Nothing tells anyone the service is
  down; the only signal is looking. Receiptless has Sentry and hit the
  same wall on log drains (a paid tier).
- **No centralised logs.** Fastify logs to stdout and whatever the host
  keeps.
- **No backups**, per section 6.
- **No rehearsed rollback**, per section 7.
