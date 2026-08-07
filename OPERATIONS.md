# IDent Operations

This doc exists for one reason: IDent is designed to be built by someone
whose attention is not always available for it — a degree, a job, or life in
general can and should take priority for long stretches. This is where that
constraint gets turned into actual engineering requirements instead of staying
a hope.

## The Founder Attention Budget

An architectural constraint, not a productivity aspiration. Every phase in
ROADMAP.md should be buildable and *operable* within these budgets — if a
phase can't be kept running inside Green mode most of the time, that's a sign
the phase shipped before OPERATE-0…7 (below) were actually satisfied for it,
not a sign the founder needs to work harder.

- **Green — normal life/study/work, the default mode.** Target: 2–4
  hours/week. Loop: review an automated status report → approve or reject
  pending decisions → hand Claude Code the next task → ask for an independent
  review of what it produced → stop.
- **Yellow — vacation / lighter-load periods.** Target: 5–10 hours/week.
  Used for releases, design changes, larger integrations — things that don't
  fit in a Green-mode review loop but also aren't emergencies.
- **Red — a genuine expansion or incident event.** 1–4 intense weeks, used
  for things like a major launch, a funding conversation, a hire, a
  regulator/carrier conversation, or a security incident. Red mode always
  ends with an explicit return to Green — it is not allowed to quietly become
  the new normal.

**How this constrains the roadmap, concretely:** a phase is not "done" if
keeping it running requires permanent Yellow/Red-level attention. That's a
signal to go back and finish the OPERATE checklist for that phase before
adding the next one, not a signal to accept a higher baseline load.

## The OPERATE checklist

Every phase should eventually satisfy all of these before the *next* phase
starts consuming founder attention. Numbered by increasing maturity, not by
build order.

- **OPERATE-0 — No routine intervention required.** The system runs without
  the founder doing anything on a normal day.
- **OPERATE-1 — Failures are detected automatically.** Nothing waits for a
  user complaint or a founder happening to notice.
- **OPERATE-2 — Safe failures recover automatically.** Retries, failovers,
  and self-healing for the class of failure that doesn't risk data integrity
  or security.
- **OPERATE-3 — Unsafe failures fail closed.** Anything that *isn't* safe to
  auto-recover disables the affected functionality rather than guessing.
- **OPERATE-4 — The founder only sees actionable exceptions.** Status
  reports are a short list of decisions, not a firehose of logs.
- **OPERATE-5 — Routine support is handled by docs + AI, not the founder.**
  Common questions have a written or automated answer before they reach a
  human.
- **OPERATE-6 — Deployment requires automated gates.** Tests and security
  checks block a bad deploy; nothing ships on "it worked on my machine."
- **OPERATE-7 — Financial health is monitored automatically.** Revenue minus
  compute, telecom, storage, and support cost is a number the system tracks
  itself, not something the founder reconstructs manually when worried.

This list is intentionally unglamorous. It's also the entire mechanism by
which a decade-scale roadmap stays compatible with Green-mode attention most
of the time.

## Pricing as an operating constraint, not just a business decision

See [BOOTSTRAP.md](BOOTSTRAP.md) for the actual tiers. The rule that matters
here: **a user's routine cost to IDent must stay bounded and attributable**,
so a single Consumption-heavy user can't silently turn a near-free membership
into a loss. OPERATE-7 is what makes that visible before it becomes a
problem instead of after.

## `IDent_STATE.md`

The file that makes Green mode possible across a gap of any length — a two-
month exam stretch, a semester, a year. It lives at the repo root
(`/Users/Omar/IDent/IDent_STATE.md`) and is the first thing to read (by a
human or by Claude Code) before doing anything else in this repo. It should
always contain, current as of the last update:

- **Current phase** — which ROADMAP.md phase is active, and which OPERATE
  items are still open for it
- **Completed components** — what's actually built and verified, not just
  attempted
- **Architecture decisions** — choices made and why, so they don't get
  silently re-litigated by someone (human or AI) picking this back up cold
- **Known failures / open issues** — anything broken or incomplete, named
  plainly
- **Next tasks** — the specific next actions, ordered
- **Deployment instructions** — how to actually run/deploy the current state
- **Security assumptions** — what's currently trusted and why, so a change in
  that trust boundary gets noticed
- **External approvals pending** — anything waiting on a partner, regulator,
  or third party outside IDent's control

The intended resumption flow, after any length of absence, is exactly one
instruction: *"Read the repository and continue the currently approved
roadmap."* If that instruction doesn't work — if it requires the founder to
supply context from memory first — `IDent_STATE.md` is out of date and that's
a bug, not a documentation nicety.
