# IDent Bootstrap Plan

**The question this doc answers:** can Phase 1 be built and grown by one
person, with no outside capital, charging a small recurring fee, without
going through a funding round or a formal company-building process — before
any of Phase 3–5's capital-intensive work is attempted?

**Short answer:** yes, for Phase 1. No, for the vault/health/finance/
biometric-payment phases, regardless of team size — those carry licensing
and legal costs that exist independent of how the software gets built. This
doc exists so that distinction stays written down instead of getting
optimistically blurred later.

## What's genuinely zero-capital

- Building Phase 1 (unified inbox, notifications, contacts, calendar,
  reminders) — buildable solo, with AI-assisted coding, on hosting that
  costs single-digit dollars a month at low user counts
- Charging users a small recurring fee through a standard payment processor
  under a sole-proprietor or individual setup — no investors required
- Iterating on the product based on direct user feedback — the natural loop
  at small scale

## What isn't zero-capital, no matter who builds it

- Phases 3–5 (Documents/ID vault, Health, Finance, biometric payments):
  licensing, KYC/AML exposure, legal review before storing health or
  government-ID data, and payment-processor vetting that gets stricter
  exactly where the data gets sensitive. These are regulatory costs, not
  engineering costs — no amount of AI-assisted development removes them.
- Phase 9 (Deviceless access): hardware token supply/logistics if IDent
  wants a recommended token rather than "bring your own FIDO2 key," and
  separate legal review specifically for the server-side biometric fallback
  — its consent, retention, and disclosure requirements are distinct from
  Phase 3's on-device enrollment (see SECURITY.md). This phase is correctly
  last precisely because it's neither cheap nor safe to rush.
- A privacy policy and terms of service that actually hold up — worth a
  fixed-fee lawyer review even at tiny scale, given what Phase 1 already
  touches (inbox contents, contacts) before Phase 3+ is ever built.

## The monetization wedge: a private AI assistant, not the plumbing

Charging for "a unified inbox" is a hard sell — it's infrastructure, and
free alternatives exist for each individual piece it aggregates. What's
worth paying for is the thing layered on top: **an assistant that can
actually answer questions about your own life**, with a privacy commitment
strong enough to be worth trusting with that data in the first place.

Proposed structure:

- **Free:** unified inbox, notifications, contacts, calendar, reminders —
  the aggregation layer, no assistant access
- **Paid (small recurring fee, e.g. ~£1/month):** the personal AI assistant,
  read-only over the user's own inbox/calendar/contacts (Phase 1 scope),
  under the privacy model in [SECURITY.md](SECURITY.md#ai-assistant-privacy)

This only works if the privacy commitment is real and specific, not a
marketing line — see SECURITY.md for exactly what "private" can and can't
mean given how LLM inference actually works, so the pitch to users doesn't
overpromise the way "100% free unlimited storage" would have in Phase 2.

## Growth without a marketing budget

No shortcut here — this is the part guidance can inform but can't execute:

- Start in one specific, small community where the unified-inbox pain is
  acute (not "everyone" — a specific niche that will actually try an
  unknown app from an unknown person)
- Word of mouth only works after the product is good enough that the first
  20–50 users would be upset to lose it — that bar comes before growth
  tactics, not after
- Support and iteration at this stage are manual and are the founder's job,
  not something to automate away early — the qualitative feedback from
  doing it manually is what later decisions get built on

## Milestones before considering Phase 2 or beyond

1. A working Phase 1 product, free tier live
2. A paying cohort — even a small one — actually renewing the assistant fee
   month over month, not just trying it once
3. A specific, named piece of user feedback that justifies the *next*
   feature, rather than roadmap momentum justifying it
4. Only then: revisit whether Phase 2 (Slack/Notion/drive/video/voice) is
   worth building, and whether Phase 3–5's capital-intensive work is
   justified by what Phase 1 has proven about willingness to pay

Phases 3–5 stay parked until this traction exists — the capital or
partnerships they require should be justified by evidence Phase 1 produced,
not assumed up front.

## What AI guidance can and can't do here

Can: help write code, docs, architecture, pricing rationale, in-app copy,
and think through tradeoffs like this one, continuously and for free.

Can't: acquire the first users, do legal review, negotiate with a payment
processor or a future licensed aggregator, provide the capital when Phase
3–5 actually need it, or replace the manual, slow, human work of building
trust with the first cohort of paying strangers. Treat this doc as a
thinking partner's input, not a substitute for the parts that are yours to
execute.
