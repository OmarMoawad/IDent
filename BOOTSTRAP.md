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

### Pricing tiers

Earlier drafts of this doc proposed a flat ~£1/month for the assistant. That
number is dropped as a fixed commitment — nobody can honestly price 2030+
infrastructure economics today — but the *intent* behind it (near-zero cost
for an individual user) is kept, and made structurally safe against the
failure mode a flat low price invites: a user whose actual usage costs more
than they pay, subsidized silently until it isn't sustainable. Four tiers
instead of one price:

- **IDent Foundation** — a small one-time activation fee (illustrative range:
  $1–5 once). Grants the long-term IDent identity itself. Not recurring —
  the identity isn't something you rent.
- **IDent Basic** — free or near-free. Covers Phase 1's aggregation layer
  (inbox, notifications, contacts, calendar, reminders) — features whose
  marginal cost per user is genuinely negligible.
- **IDent Maintenance** — a small recurring fee, sized to actual operating
  cost rather than picked in advance (illustrative range: $0.50–2/month
  today; the number is expected to move as infrastructure costs move). Funds
  the personal AI assistant under the privacy model in
  [SECURITY.md](SECURITY.md#ai-assistant-privacy).
- **Metered services** — anything with real, variable marginal cost (heavy
  AI inference, large cloud storage, SMS, international calling, telecom
  data, financial operations) is charged near actual incremental cost plus a
  small margin, not subsidized by the flat tiers above. This is what keeps a
  $1/month member from being able to generate $20/month of AI/telecom/storage
  cost and quietly making every other user's subscription unprofitable — see
  [OPERATIONS.md](OPERATIONS.md)'s OPERATE-7 for how this gets monitored
  rather than discovered after the fact.

**The governing principle, written down so it doesn't drift:** core
membership should target the lowest price compatible with long-term
security, reliability, regulatory compliance, and solvency — not the lowest
price achievable by quietly under-pricing metered cost. "Cheap for the
individual" and "commercially sound as a company" are meant to be
compatible, not in tension, once consumption-heavy services are priced to
cover themselves separately from membership.

This only works if the privacy commitment is real and specific, not a
marketing line — see SECURITY.md for exactly what "private" can and can't
mean given how LLM inference actually works, so the pitch to users doesn't
overpromise the way "100% free unlimited storage" would have in Phase 2.

### Revenue diversification (later eras, not Phase 1)

Once Phase 1 is proven, the consumer side of IDent can stay priced near cost
while revenue comes increasingly from elsewhere: enterprise identity APIs,
verified-credential transactions, telecom wholesale margin (Phase 10),
network APIs, business communications, premium AI consumption, institutional
integrations, and enterprise security/compliance tooling. None of this is a
Phase 1 plan — it's the reason a near-free consumer tier doesn't have to mean
a company that can't sustain itself, once later eras exist at all.

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
