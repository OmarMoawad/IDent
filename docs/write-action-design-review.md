# Write actions: design review

**Session 24's review half.** `write-action-threat-model.md` closed with
"a design reviewed only by its author is a design with one perspective in
it", and prerequisite 1 asks for a reader who did not write it. This is
that read.

Reviewed 2026-08-21, against the repository rather than against the
document's own account of itself — the same method that found three
corrections in Session 23 after it had already closed.

**Scope.** Design only; nothing here proposes building the write path.
Two of the six findings are corrections to statements in the threat model
that the code contradicts, three are gaps the design does not cover, and
one is now closed by code in this session.

## Verdict

The design is sound where it is load-bearing. §1 — the model proposes
intent, the server constructs the action — is the right decision and it
is what defeats the confused-deputy and parameter-smuggling attacks;
nothing in this review weakens it. The hardening added on 2026-08-21
(execution state machine, retry eligibility, aggregation limits, audit
access controls) closes the gaps that a first read of the original draft
would have raised, and they are not restated here.

What remains is narrower and more specific: **two of the mechanisms the
design says it will reuse do not have the properties it assumes**, and
**one attack in its own list is not closed by anything in it.**

## F1 — Step-up cannot mean "every time" with the mechanism reused

**Severity: high. The design assumes a property the code does not have.**

§4 reuses `identity/elevation-routes.ts`, and §6 requires standing
changes to "require step-up every time". §3's hardened wording asks that
"any required elevation is still fresh".

Elevation is a **time window on the session**, not a per-action approval:

- `ELEVATION_TTL_MS` is five minutes (`apps/api/src/identity/session.ts:16`).
- `isElevated` tests `elevatedUntil > Date.now()`
  (`apps/api/src/identity/elevation.ts`).
- `requireElevatedSession` is a preHandler that passes any request inside
  that window.

So one `/identity/elevate/*` call authorises **every** action for the
next five minutes. "Step-up every time" is not expressible with this
mechanism, and "elevation is still fresh" is satisfied vacuously for the
whole window. This matters most against attack 7 (escalation by
aggregation), which is precisely a series of actions inside one window —
the §6 aggregation controls added on 2026-08-21 now bound the series, but
step-up was named as an independent control and it is not one.

**Fix to specify:** elevation must be *consumed by* a specific pending
action rather than held by the session — bind an elevation to one action
id, single-use, or require the elevation event to be newer than the
pending action's creation and consumed on execution. There is already a
per-elevation event to bind to: `elevateSessionById` rotates the session
token in the same update, so an elevation is a discrete, observable
moment and not merely a timestamp bump.

Recording the cost, because reuse was the argument for §4: this is no
longer "reuse the thing that exists". It is a real addition to the
elevation subsystem, and it should be priced into session 5 rather than
discovered in it.

## F2 — Prerequisite 3's premise is wrong; its conclusion survives for a different reason

**Severity: medium. Right conclusion, wrong reason — which matters,
because the wrong reason under-specifies the limit.**

Prerequisite 3 says the confirm and execute endpoints get "their own
buckets rather than the default", implying that without them the routes
are unthrottled. They would not be. `policiesForRoute`
(`apps/api/src/rate-limit/policy.ts`) falls through to `default-write`
for any unlisted POST, and the module says so in as many words: "a new
route is throttled the day it is written."

The real argument is the **number**. `default-write` is 120 requests per
minute per session. That is a sensible brake on a runaway client and a
wholly inappropriate ceiling for an endpoint whose effect is sending
mail. It is also, by construction, looser than any aggregation threshold
§6 would set — so if the bucket is left at the default, the rate limit
never binds and the aggregation control is the only thing standing
between an injected loop and a hundred sends a minute.

**Fix to specify:** state the confirm/execute limits as numbers, and
require them to be tighter than the per-action aggregation thresholds
rather than merely "their own bucket".

## F3 — Nothing binds a proposal to the retrieval slice it came from

**Severity: high. An attack in the document's own list is not closed by
the design.**

§1 says the model emits "references to objects it may name (a message id
from the retrieval slice, a contact id)". §3 revalidates at execution
that the identity still owns the target. Both are true. Neither enforces
that the named id was **in the slice**.

Within a single identity, ownership re-checks pass for every message the
person has. So injected text can name a target the user's question never
surfaced — "archive the message from the bank", "reply to the message
from legal" — and every control in the design is satisfied: the server
constructs the payload, the identity owns the target, the preview is
server-rendered and accurate. The preview is accurate *about the wrong
object*, and the user is being asked to confirm an action about a message
they were not thinking about. That is attack 3 (parameter smuggling)
surviving §1, in the one place §1 does not reach: the target reference
rather than the payload fields.

**Fix to specify:** persist the slice's id set with the pending action,
and reject a target that is not a member. This is cheap —
`buildAssistantContext` (`apps/api/src/assistant/assistant-retrieval.ts`)
already computes exactly the bounded set and is already the privacy
boundary; it currently returns `counts` and would return ids alongside
them. Doing it there also keeps one definition of "what the model could
see", rather than a second, looser one at action time.

## F4 — The structural guarantee is true, but not verifiable the way it is phrased

**Severity: low, documentation only.**

"No code path leads from a model response back into the database" is
correct. But it invites verification by directory, and
`apps/api/src/assistant/importance-service.ts` imports the `db` handle
and writes `messagePriorities` and `priorityRules`. It is not a
counter-example — it classifies with a regex heuristic and deliberately
never calls a model, which its own header explains at length — but a
reader checking the claim by looking at `src/assistant/` will find a
write and conclude the guarantee is already broken.

**Fix:** state the boundary as the *seam* rather than the directory:
model output reaches exactly one field, `AssistantResult.answer`, and the
modules it flows through are the ones that must stay write-free. The test
added this session is written that way, and says why in a comment.

## F5 — The injection regression was deferred. It now exists.

**Closed in this session.**

Prerequisite 8, added 2026-08-21, says to write the injection regression
"when implementation begins". That is later than both the roadmap and the
threat model ask for, and it leaves today's guarantee unenforced in the
meantime — the period during which it is easiest to remove by accident,
because nothing depends on it yet.

`apps/api/src/assistant/write-action-injection.test.ts` now holds it: a
model that complies with an injected instruction and reports success
changes nothing, no route exists that turns an answer into a write, and
the seam reaches nothing that mutates. Verified non-vacuous by adding a
write import to the seam and confirming the test fails.

## F6 — Prerequisite 2 was open and gated the rest. Closed 2026-08-21.

**Severity: medium. Was a product decision, not an engineering one —
Omar agreed the recommendation below on 2026-08-21, and it is now
recorded in [write-action-catalogue.md](write-action-catalogue.md) with
each action's step-up requirement, retry eligibility, aggregation limits
and compensation policy.**

"The enumerated action set agreed and written down" is a prerequisite
with no proposal against it, and everything else is sized by it: the
audit schema, the aggregation thresholds, the retry-eligibility table and
the compensation policy are all *per action type*. Session 5 cannot be
estimated, let alone built, until the list exists.

A starting set is proposed below to be argued with rather than adopted.
The principle is the document's own — every entry is permanent attack
surface — so the first version should be embarrassingly small and should
avoid any irreversible external effect.

| Action | Effect | Why it is in v1 |
| --- | --- | --- |
| `reply.draft` | Creates a **draft** reply to a message in the slice | Exercises the entire architecture — intent, server-built payload, preview, approval, execution, audit — with no irreversible effect. A wrong draft is deleted by the user; a wrong send is not. |
| `message.archive` | Archives one message | Reversible, single-target, tiny blast radius. The natural second case for target-state revalidation (§3): "archive this unread message" is the document's own time-of-check example. |
| `calendar.event.accept` | Responds to an invitation already in the slice | The only one with an outbound side effect, and a socially cheap one. Proves the provider-idempotency path on an action whose duplicate is harmless. |

Deliberately **not** in v1: sending mail, forwarding, deleting, any rule,
filter or auto-reply, and any contact write. Sending is the action the
feature is *for*, and leaving it out of v1 is the recommendation: ship
`reply.draft` first, and let the step from draft to send be its own
decision made against a working system rather than a designed one.

## What this review did not do

- **It did not test any of this.** There is nothing to test; the design
  is unimplemented, and F5's regression covers the guarantee that exists
  today, not the design that would replace it.
- **It is still one reader.** It is a second perspective on the threat
  model, not an independent security review, and it was produced by the
  same kind of author as the document it reviews. The external review
  that produced session 22's finding list was worth more than this is.
- **It did not revisit the hardening added on 2026-08-21**, beyond
  checking that F1–F3 are not already covered by it. Those additions
  arrived after the draft this review started from.

## Recommendation

Session 24's exit condition — reviewed, not built — is met. Three things
should land in the threat model before session 5 is planned: the
elevation binding (F1), the confirm/execute numbers (F2), and slice
membership as an enforced constraint (F3).

F6 is closed, and closing it surfaced a dependency worth stating: **no v1
action requires step-up, so F1 does not block v1** — but every action
excluded from v1 does require it, so F1 must be built before any of them
is promoted. Slice membership (F3) is load-bearing from day one, because
all three v1 actions take a target id from the slice.
