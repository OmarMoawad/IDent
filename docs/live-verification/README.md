# Live-verification artifacts

Machine-generated, sanitized evidence that the session-5 write actions were
run end-to-end against a real Google account through the production path
(propose → confirm → execute). Each artifact is produced *by* a verification
run, not hand-written — so it records a real run rather than a claim a
reviewer cannot check.

## Generating one

1. Local Postgres up (`docker compose up -d`) and migrations applied
   (`npm run db:migrate`).
2. A Google source reconnected with `gmail.modify` + `calendar.events`
   (the write scopes; a read-only grant is reported ineligible).
3. Run: `npm run verify:live -w apps/api`

The run creates a reply draft (never sent), archives **and then restores** a
message (inbox left as found), and — if a pending invitation exists — accepts
it, then writes `docs/live-verification/<timestamp>.json`.

## What's in it, and what's deliberately not

- **Included:** artifact version, repo, timestamp, git commit SHA, granted
  scopes, and per action a `status`, `outcomeCode`, a salted-hash `targetRef`,
  and a `before`/`after` state (label presence, attendee response,
  draft-created + threaded).
- **Never included:** email addresses, subjects, bodies, event titles, raw
  provider ids, or tokens. Ids are replaced by a per-run salted SHA-256 prefix,
  so a target cannot be identified or correlated across artifacts.

## Field reference

```jsonc
{
  "artifactVersion": 1,
  "repo": "IDent",
  "generatedAt": "<ISO 8601>",
  "commit": "<git SHA or null>",
  "identityRef": "<salted hash>",
  "grantedScopes": ["https://www.googleapis.com/auth/gmail.modify", "..."],
  "verifications": [
    {
      "action": "reply.draft | message.archive | calendar.event.accept",
      "status": "verified | skipped | failed",
      "outcomeCode": "ok | duplicate | ...",
      "targetRef": "<salted hash>",
      "before": { /* safe state, e.g. { "inbox": true } */ },
      "after": { /* safe state, e.g. { "inbox": true, "restored": true } */ }
    }
  ]
}
```

`calendar.event.accept` reports `status: "skipped"` when no pending
invitation exists on the primary calendar.
