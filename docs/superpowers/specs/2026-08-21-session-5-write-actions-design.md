# Session 5 Write Actions Design

## Status and Goal

This specification implements the Phase 2 Session 5 write-action catalogue approved in Session 24. IDent will support three actions: create a Gmail reply draft, archive Gmail messages, and accept a Google Calendar invitation. Sending mail, deleting data, arbitrary recipient selection, and model-directed provider calls remain out of scope.

The security objective is stronger than “the model usually behaves”: model output can propose a constrained intent, but only authenticated server code can construct, approve, and execute an action. Prompt-injected content must never reach a write provider before a human confirms the exact server-rendered effect.

Session 24 is already complete and will not be repeated. Its wording will be corrected from “Session 5 is unblocked entirely” to “Session 5 is ready to start,” because provider permissions and the implementation below remain prerequisites.

## Chosen Architecture

The assistant remains a retrieval-and-reasoning component. A new write-action subsystem sits beside it behind explicit capabilities:

1. Retrieval returns bounded context plus opaque references such as `message:1` and `event:1` mapped to the exact identity-owned records in that request.
2. The model may return only a strict discriminated intent: `reply.draft`, `message.archive`, or `calendar.event.accept`, with an opaque target reference and the minimum action-specific content.
3. A proposal capability resolves the reference against the persisted retrieval slice and constructs a canonical server-owned payload and preview. Unknown fields and non-slice targets are rejected.
4. Confirmation binds a live identity session to the displayed payload digest.
5. A separate executor capability atomically claims the approved action and calls a narrowly scoped provider adapter.

Assistant orchestration receives proposal and execution capabilities through explicit interfaces. Unit tests inject recording fakes and assert zero execution calls before confirmation. The existing static seam scan remains only as a secondary tripwire and will no longer be described as transitive architectural proof. An import-boundary rule prevents assistant/model modules from importing provider write adapters directly.

Provider adapters that have a verified structured-output contract may return action intents through that contract. A local or OpenAI-compatible adapter without a verified structured contract remains answer-only: its prose is never parsed heuristically into an action.

## Model and Payload Boundary

The model never supplies provider IDs, identity IDs, OAuth material, recipients, CC/BCC fields, operation keys, or state preconditions. It can supply only:

- `reply.draft`: one `message:<n>` reference and draft body text;
- `message.archive`: one to ten `message:<n>` references;
- `calendar.event.accept`: one `event:<n>` reference.

The server resolves all targets from the exact retrieval slice. Reply drafts are sender-only in v1; there is no reply-all, CC, BCC, attachment, or arbitrary-address support. The server derives reply headers and recipient from the stored/provider message. Calendar response is fixed to `accepted`.

Canonical JSON uses stable key ordering and a schema version. The server hashes the canonical bytes with SHA-256. The UI renders only the server preview and sends that digest back on confirmation; model prose is never approval text.

## Persistence and State Machine

An additive migration introduces:

- `assistant_pending_actions`: identity, requesting session, action type, schema version, canonical payload, digest, persisted retrieval slice, immutable preconditions, status, expiry, operation key, provider-safe outcome, and timestamps;
- `assistant_action_approvals`: immutable approval records containing action, identity, confirming session, digest, and timestamp;
- `assistant_action_audit_events`: append-only proposal, approval, execution-claim, outcome, expiry, cancellation, and recovery events with a per-action hash chain;
- `assistant_elevation_events` and per-action consumption records, providing a future single-use step-up capability instead of relying only on the existing reusable five-minute session window.

Payload, digest, identity, slice, operation key, and approval rows are immutable. Database triggers reject updates/deletes to approval and audit rows and reject changes to immutable action columns. Application roles receive only the operations they require. Audit records contain stable references and safe outcome codes, not OAuth tokens, raw provider responses, full message bodies, or duplicated draft text beyond the canonical action payload.

The state machine is:

```text
pending -> approved -> executing -> succeeded
                              \-> failed
                              \-> outcome_unknown
pending/approved -> expired
pending/approved -> cancelled
```

Actions expire ten minutes after proposal. Confirmation and execution use guarded database updates that verify current status, digest, identity, and expiry. One unique operation key and one atomic execution claim make concurrent/replayed execution single-shot. An `outcome_unknown` action is never retried until an authoritative provider lookup resolves it.

## HTTP and UI Flow

The assistant response may include server-created pending-action cards. The web app then uses:

- `GET /identity/assistant/actions/:id` to refresh current state;
- `POST /identity/assistant/actions/:id/confirm` with the displayed digest;
- `POST /identity/assistant/actions/:id/execute` with the approval identifier and digest;
- `POST /identity/assistant/actions/:id/cancel` while pending or approved.

Every operation authenticates independently and scopes by identity. A different valid session for the same identity may confirm or execute; both requesting and acting sessions are audited. Cards show the exact target/effect, recipient and body for drafts, batch count for archive, expiry, and explicit `executing`, `succeeded`, `failed`, `outcome unknown`, `expired`, or `cancelled` states.

Archive accepts at most ten targets per confirmation and always shows a server-rendered aggregate preview for multi-message actions. More than ten is rejected rather than silently split. Compensation such as unarchive or changing an RSVP is a new previewed action, not hidden rollback.

## Authorization, Permissions, and Limits

Provider execution rechecks the identity, source ownership, live connection, granted scopes, target existence, and provider state immediately before mutation. OAuth configuration moves from read-only grants to `gmail.modify` and `calendar.events`. Existing connections without those grants are marked action-ineligible and receive a reconnect/consent prompt; read-only assistant use continues to work.

No v1 action requires step-up, but policy evaluation accepts a per-action elevation requirement and can consume a single elevation event. This closes Session 24 finding F1 without pretending the current session-wide elevation window is single-use.

Business-effect ceilings are identity-wide rolling-hour controls:

- reply drafts: 20 effects per hour;
- archive: 10 targets per confirmation and 50 effects per hour;
- calendar acceptance: 5 effects per hour.

Effect aggregation is consumed when execution is claimed, including provider failures, so repeated failing calls cannot obtain extra provider attempts. Confirmation and execution HTTP requests are separately limited to 10 per minute per session and 30 per rolling hour per identity; rejected replays and malformed/stale attempts count. The action-effect ceilings above remain the tighter control for calendar actions and large archive batches. The threat model will distinguish request-abuse limits from business-effect aggregation instead of claiming one generic route limit is “tighter” than three incomparable effect ceilings. All limits are enforced in the action service, not only in the UI or Fastify fallback policy.

## Provider Adapters and Recovery

`MailWriteClient` and `CalendarWriteClient` are separate from OAuth lifecycle code and receive access tokens only after the connection service performs ownership and scope checks.

- Draft creation builds MIME server-side and includes a deterministic RFC 5322 `Message-ID` derived from the operation key. On timeout, the adapter searches for that identifier before returning `outcome_unknown`.
- Archive removes the `INBOX` label. Provider state is fetched first; an already-archived message is a known idempotent success. A timeout is resolved by refetching labels.
- Calendar acceptance fetches the event and authenticated attendee, checks it remains actionable, and patches only that attendee response. Re-fetching the attendee response resolves retries/timeouts; already accepted is a known success.

Provider error bodies are mapped to safe categories. Tokens, headers, message contents, and raw responses are excluded from logs and audit events.

## Testing and Acceptance

Tests are written before production behavior and cover:

- strict intent parsing, unknown fields/types, fabricated references, and non-slice targets;
- server ownership of recipients, provider IDs, preconditions, operation keys, and previews;
- injected content producing at most a pending proposal and zero executor/provider calls before confirmation;
- the explicit capability boundary and import restriction, with the old static scan retained as a tripwire;
- cross-identity access, stale/revoked sessions, disconnected sources, missing scopes, changed target state, stale digests, expiry, and cancellation;
- concurrent confirmation/execution, replay, idempotent known outcomes, provider timeout recovery, and unresolved outcomes;
- effect aggregation and attempt-limit bypass attempts across many proposals/sessions;
- append-only audit controls, redaction, hash-chain verification, and per-action elevation consumption;
- web preview, reconnect prompt, aggregate archive confirmation, and every terminal/ambiguous state.

Completion requires API/web tests, typecheck, migration safety, production builds, documentation/state/badge updates, and a real connected-account verification for each provider mutation. If real Google consent or provider verification is not completed, the code may be implementation-complete but the session is not reported as deployed-and-verified.

## Explicit Non-goals

- Sending mail, deleting messages/events, reply-all, arbitrary recipients, attachments, or free-form provider tools.
- Automatic retry of an ambiguous mutation.
- Treating model compliance as the security boundary.
- Reusing a session-wide elevation window as proof of per-action authorization.
- Repeating or relabelling Session 24.
