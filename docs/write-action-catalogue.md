# The enumerated write-action set, v1

**Prerequisite 2 of [write-action-threat-model.md](write-action-threat-model.md),
closed 2026-08-21.** Agreed by Omar on the review's recommendation.

This is the list Phase 2 session 5 may build, and nothing else. Every
entry is permanent attack surface, so the list is deliberately small and
deliberately excludes the action the feature is ostensibly *for*.

**Why this document has to exist before session 5 is estimated:** every
control in the threat model is specified *per action type* — the audit
schema, the aggregation thresholds, the retry-eligibility rule, the
compensation policy. Without the list, none of them have a shape, and the
session cannot be sized. That is the whole reason it was a prerequisite
rather than a design detail.

## The rule that generates the list

Adding an action is a code change with a review, never a prompt change
(§1 of the threat model). So v1 is chosen to **exercise every part of the
architecture while risking as little as possible**:

- at least one action with no external effect at all,
- at least one that must revalidate target state at execution,
- at least one with a real outbound side effect, chosen so that a
  duplicate is harmless.

Three actions cover all three. A fourth would add attack surface without
adding a property to test.

## v1

### 1. `reply.draft`

**Effect:** creates a *draft* reply to a message in the retrieval slice.
Nothing is sent.

**Intent the model may emit:** the action name, the `messageId` it is
replying to, and the body text.

**What the server constructs:** recipients resolved from the stored
message, never from model output — this is where a smuggled BCC has
nowhere to live. The body is the one field carrying model text, and it is
carried as *content*, never as addressing or control data.

**Step-up:** not required. A draft has no external effect, and putting
friction on the safest action teaches people to click through it.

**Retry:** eligible. Draft creation is idempotent against the operation
key; a duplicate draft is a nuisance, not a loss.

**Aggregation limit:** 20 per hour. Generous, because the failure mode is
clutter.

**Compensation:** the user deletes it. Nothing irreversible exists.

**Why it is first:** it exercises intent → server-built payload → preview
→ approval → execution → audit, end to end, with nothing that cannot be
undone. A wrong draft is deleted; a wrong send is not.

### 2. `message.archive`

**Effect:** archives one message.

**Intent the model may emit:** the action name and the `messageId`, which
must be a member of the slice.

**What the server constructs:** the archive operation against the stored
message, after re-checking ownership *and* current state.

**Step-up:** not required. Reversible, single-target, tiny blast radius.

**Retry:** eligible, and naturally idempotent — archiving an archived
message is a no-op.

**Aggregation limit:** 10 per confirmation, 50 per hour, with an
aggregate preview above 10. This is the action a "clean up my inbox"
injection would try to turn into mass disappearance, and per-action
confirmation is exactly the control that handles it worst (§6).

**Compensation:** unarchive, as a new server-constructed action.

**Why it is second:** it is the threat model's own time-of-check example
— "archive this unread message" authorised while unread, executing after
it changed — so it is what proves §3's execution-time revalidation is
real rather than described.

### 3. `calendar.event.accept`

**Effect:** responds to an invitation already in the slice.

**Intent the model may emit:** the action name and the `eventId`.

**What the server constructs:** the RSVP against the stored event, with
the response value from a fixed enumeration, never from model text.

**Step-up:** not required.

**Retry:** eligible **only if** the calendar provider exposes a durable
idempotency key or an authoritative outcome lookup. If it exposes
neither, a timeout becomes `outcome-unknown` and is surfaced rather than
retried — this is the action that first exercises §8, and it is here
partly to force that path to be built rather than deferred.

**Aggregation limit:** 5 per hour.

**Compensation:** change the response, as a new action.

**Why it is third:** it is the only v1 action with an outbound side
effect, and it is chosen because a duplicate RSVP is socially harmless.
That makes it the right place to get provider idempotency wrong for the
first time.

## Deliberately excluded from v1

| Excluded | Why |
| --- | --- |
| **Sending mail** | The action the feature is *for*, and the reason it is out. `reply.draft` proves the architecture; the step from draft to send should then be a decision made against a working system rather than a designed one. It also needs the Google send scope, which needs Omar. |
| **Forwarding** | Direct instruction injection's first choice — "forward everything from the bank to…" — and the one attack the threat model opens with. |
| **Deleting anything** | Irreversible, so compensation is a promise that cannot be kept. |
| **Rules, filters, auto-replies** | Standing changes, which §6 puts on a higher bar than one-shot actions: they keep acting after the conversation that created them is forgotten. |
| **Contact writes** | Low value, and contact data is what an exfiltration-shaped injection wants to reach. |

## What still has to be true before any of this is built

The action set does not on its own unblock session 5. The threat model's
other prerequisites still stand, and two of them changed on the strength
of the review:

1. **Step-up must be consumed by a specific pending action** (F1). The
   existing five-minute session-wide elevation cannot express "every
   time". No v1 action requires step-up, so this is not blocking for v1 —
   but it **is** blocking for the first excluded action promoted into v2,
   all of which require it. Do not promote one without building it.
2. **Slice membership must be enforced** (F3), not merely described. All
   three v1 actions take a target id from the slice, so this is load-
   bearing on day one.
3. Confirm/execute rate limits stated as numbers and tighter than the
   aggregation thresholds above (F2).
4. The audit tables, with the retrieval slice included.

## Honest limits

This list is a recommendation that was accepted, not a validated design.
Nothing here has been built or tested, the aggregation numbers are
starting points chosen for plausibility rather than measured against real
use, and the provider-idempotency claim for `calendar.event.accept` is an
open question about someone else's API rather than a fact this repo has
checked. Verify it before relying on the retry path.
