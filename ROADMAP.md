# IDent Roadmap

This roadmap sequences delivery by **trust tier**, not by feature popularity.
Modules that only aggregate low-stakes data (news, music) ship early and
loosely coupled. Modules that touch money, government identity, biometrics,
or health data ship later, behind stronger isolation, and often depend on
licensed third-party partners rather than being built from scratch — see
[SECURITY.md](SECURITY.md) for why.

Each phase assumes the previous phase's foundations are in place. Nothing
here is a committed timeline — it's a dependency-ordered build sequence.

## Eras (long-horizon framing)

The phases below group into five eras when thinking on a decade-scale
horizon. This is framing, not a new dependency structure — the phase-by-phase
gating rules elsewhere in this doc are still what actually decides sequencing.
Calendar bands are illustrative only, per the "nothing here is a committed
timeline" rule above.

| Era | Phases | Theme |
|---|---|---|
| I — Build the brain | 0 (+ platform/security automation, see OPERATIONS.md) | Executable repo, identity core, security automation — prerequisite infra, no user-facing product yet |
| II — Build something people pay for | 1 | Communications hub MVP + the paid AI assistant wedge — the first real product and the first revenue |
| III — Personal infrastructure | 2, 3, 4 | Productivity, native comms, vault/credentials, education, health |
| IV — Money & the physical world | 5, 6, 7 | Finance aggregation, biometric payment, devices, digital keys, belongings, logistics |
| V — Telecommunications & closing the loop | 8, 9, 10 | Personal/discovery modules, deviceless access, and — only if everything above is stable and profitable — the telecom track |

**The non-negotiable rule across all five eras:** a later era never starts
merely because a calendar says enough time has passed. Each era inherits a
stable, profitable, sufficiently-automated foundation from the era below it —
see [OPERATIONS.md](OPERATIONS.md) for what "sufficiently automated" means in
concrete terms (the OPERATE-0…7 checklist) and for the Founder Attention
Budget that's meant to keep any of this compatible with a demanding day job,
degree, or anything else competing for the same hours.

**On mission vs. sequencing:** IDent's mission (README.md) has two parts —
walking out with nothing but yourself (no wallet, no keys, no documents,
Phases 3–6), and being able to get to what you need even without a phone or
laptop on you at all (Phase 9). Neither ships early, because both require
the trust-tier foundations underneath them to already be proven: you can't
safely offer alternative access to a vault that doesn't exist yet, and you
can't safely offer it without the on-device auth model (Phase 0/3) to
compare it against. A user gets meaningful pieces of the mission long before
it's complete — ID sharing in Phase 3, a phoneless unlock in Phase 6, a true
zero-device fallback only in Phase 9. That gap is intentional — see
SECURITY.md for why skipping ahead on any of it isn't actually available as
an option.

---

## Phase 0 — Identity Core & Platform Foundation

Prerequisite for every other phase.

- Username + password identity (self-chosen handle, not phone-number-keyed)
- Passkey / WebAuthn support and optional device-local biometric unlock
- Session, token, and per-module key management (see ARCHITECTURE.md)
- Client shells: iOS, Android, Web, Desktop — thin, mostly UI + sync
- API gateway and the module-isolation pattern all later services plug into
- Baseline E2E encryption primitives (client-side key generation, wrapped keys)

**Exit criteria:** a user can create an account, log in from two devices, and
have an empty but architecturally-correct shell to build modules into.

## Phase 1 — Communications Hub (MVP wedge)

The first user-facing product. Deliberately narrow: prove the "unify, don't
replace" model before adding anything sensitive.

- Unified inbox: messages + notifications pulled from connected sources
  (**free**)
- Contact cards (unified contact record, not yet calling) (**free**)
- Calendar + reminders (**free**)
- Basic AI assistant: read-only Q&A over the user's own inbox/calendar/
  contacts (**paid** — the monetization wedge, see BOOTSTRAP.md)
- AI-assisted importance filtering: surfaces what matters and quiets what
  doesn't, but as a *negotiated* filter, not a silent one — every
  deprioritized item stays visible and reachable (nothing is auto-deleted
  or hidden outright), the user can see why the assistant called it
  low-priority and override any single call or the rule behind it, and the
  bar is tunable per source/contact rather than one fixed "importance"
  model imposed on everyone. Defers to the user's stated preferences over
  its own guess whenever the two conflict. (**paid**, part of the
  assistant wedge)

**Exit criteria:** daily-driver usable as a notification/inbox aggregator,
with a working, honestly-described private-assistant upsell.

### Production exit gate — permanent domain and Session 23

Before Phase 2 adds new user-facing surface area, Phase 1 must be exercised
as a production-like vertical slice. The permanent WebAuthn relying-party
domain is a hard prerequisite: a registrar cart is not a reservation, and a
temporary host domain would make passkeys disposable when the origin changes.

- ~~Purchase `ident.best` before Session 23.~~ **Done 2026-08-20:** one
  year through 2027-08-20, EGP 85.46 charged; auto-renew and private WHOIS
  are on, no add-on trial was purchased, and the registrar account uses a
  passkey plus TOTP. Keep recovery on an external address rather than an
  `@ident.best` inbox.
- Use `ident.best` for the web app and WebAuthn RP ID, and
  `api.ident.best` for the API. Do not register test passkeys against a
  temporary Vercel or Railway hostname.
- Keep a no-real-users decision window through **2026-09-03**. A domain
  change inside that window requires deleting test accounts/passkeys,
  updating OAuth/origins/DNS and repeating Session 23; after onboarding,
  a redirect preserves navigation but cannot migrate passkeys.
- **Session 23 completed 2026-08-21:** Vercel web, Railway API and Neon Postgres
  are deployed; `ident.best` and `api.ident.best` now pass external HTTPS
  checks. The personally controlled Google OAuth project/client and Railway
  secrets were completed on 2026-08-21. An independent private Google Drive
  backup and isolated Postgres 18 restore rehearsal were also completed on
  2026-08-21, with the checksum and restored object counts recorded in
  `DEPLOYMENT.md`. The `omartest` owner test identity completed passkey login
  and real Google consent after Gmail and Calendar APIs were enabled; Railway
  centralized logs were inspected; and rollback plus forward recovery were
  rehearsed against production. The external verifier passed all 7/7 automated
  checks against `api.ident.best` on 2026-08-20.
  Railway is on a 30-day/$5 trial, so a paid-plan decision is also required
  before relying on it beyond the trial. See `DEPLOYMENT.md`.

This gate was part of Phase 1 completion, not a Phase 2 feature. Its evidence is
recorded in `IDent_STATE.md`. The Phase 2 sequencing gate is satisfied **except
for the two open ends below**, which come before any new session.

### Session 23a — close the deployment gate's two open ends (do this first)

Reviewing Session 23 after it closed found two things that its own notes did
not record. Neither is new feature work and neither takes long, but both sit
ahead of Session 24 and ahead of any Phase 2 session: one can take production
down, and the other means a claimed capability may not exist.

**1. Repoint Railway from `docs/schedule-ident-best` to `main`. Needs Omar.**

Production's API is built from a feature branch. Merging that branch's PR and
deleting it — the normal end of every session here — removes the ref Railway
builds from, and the failure surfaces as production going stale or failing its
next deploy rather than as anything red in GitHub. The same split means the web
app and the API are currently built from *different* code: Vercel deploys
`main`, Railway deploys the branch.

The order is the whole point, because `main` is behind the branch by all of
Session 23:

1. Merge PR #13 so `main` carries Session 23.
2. Repoint the Railway service to `main`.
3. Confirm a deploy from `main` passes `/health` and
   `node scripts/verify-deployment.mjs https://api.ident.best`.
4. Only then delete the branch.

Repointing before merging would roll production backwards; deleting before
repointing would leave it with nothing to build. Done when both surfaces
deploy from `main` and the verifier is green against a `main` build.

**2. Reconcile the backup's zero identity count. Needs Omar.**

The restore rehearsal recovered zero identities from a database that
`omartest` had registered against earlier in the same session. Both cannot be
true, and the worse explanation — that the dump came from a database the API
does not write to — would mean the archive is not a backup of production at
all.

Until it is settled, the rehearsal proves the schema and migration history
round-trip and **nothing about data**, which is weaker than the gate claimed.
Settle it with `node scripts/reconcile-backup.mjs`, which does the whole
comparison in one command — see `DEPLOYMENT.md` §6 for the three outcomes and
which one actually closes the gate. Done when it reports RECONCILED and §6
carries the numbers instead of the caveat.

Only after both are closed does the automation follow-up (daily dumps,
external uptime alerting, the Railway paid-plan decision) resume its place in
the queue — and Session 24 stays where it is, behind these.

## Receiptless — Commerce & Receipts (separate repo, early integration target)

Not a numbered phase, deliberately: unlike Phases 1–10, this isn't an
IDent-authored dependency chain — it's an independently-developed product
(`/Users/Omar/receiptless`, `github.com/OmarMoawad/receiptless`, own
README/ROADMAP.md) that this roadmap only documents the *integration
contract* for, not the build plan. Sequenced in the doc right after Phase
1 because that's roughly where it belongs on the trust-tier scale — not
because it's IDent-built work item #2.

**What it is:** an interoperable digital receipt/purchase layer — a
purchase generates a structured receipt that reaches a private vault via
QR claim-token, photo, email, or (later) merchant API/POS/NFC, and stays
permanently searchable (warranties, return windows, spend intelligence).
See its own ROADMAP.md for the full plan (it's substantial and shouldn't
be duplicated here).

**Why it's called out here despite being a separate repo:** purchase/
receipt data is a *materially* lower trust tier than Phase 5's banking
data — Receiptless's own positioning is explicit that it answers "what
did I buy," never "how did I pay," and has no plan to become a payment
processor. That means it doesn't need to wait behind Phase 5's
licensed-aggregator machinery the way real financial data does. It also
solves a real problem for IDent specifically: an identity platform has a
chicken-and-egg adoption problem ("why would anyone create a new
identity?") that abstract infrastructure can't answer on its own. "Every
receipt, warranty, and return automatically follows you" is a concrete,
ordinary consumer reason a communications hub alone doesn't provide —
this is a candidate for IDent's first real adoption driver, not just
another module.

**Integration shape (not built on either side yet — both repos are
independently useful and stay that way until this is real):**
- **IDent is the identity authority, Receiptless is the commerce
  layer.** Receiptless would store an `ownerSubjectId` referencing
  IDent's `identity_id` (see ARCHITECTURE.md's Data model note), not a
  duplicated user/auth table — matching this doc's existing "don't
  rebuild every subsystem inside Identity Core" principle.
- **Repos stay separate. No monorepo merge.** Integration happens through
  explicit HTTP contracts (identity resolution, consent checks, credential
  issuance) — the same "own datastore, no shared tables across modules"
  rule ARCHITECTURE.md's Domain services section already applies to
  IDent's own modules extends naturally to an external one.
  Receiptless already qualifies as a separately-deployed service under
  that section's Phase 0–2 modular-monolith carve-out, since it's a
  distinct trust domain by construction, not a shortcut being taken.
- **Never one universal public identifier handed to every merchant.**
  Today's Data model note only covers the single public `@username`;
  merchant-facing purchase flows need their own scoped, pseudonymous
  identifier per relationship so a supermarket, a carrier, and a hospital
  can't trivially correlate the same person across each other. This is a
  real gap, not designed yet — logged in IDent_STATE.md's future
  architecture gaps rather than half-designed here.
- **Prerequisite on both sides, not built yet:** Receiptless needs its own
  Phase 1 (multi-user accounts — today it's one shared vault, no auth);
  IDent needs a consent/scoped-alias system beyond today's single public
  username. Neither blocks the other's current, independent progress.
- **Branding stays separate** ("Receiptless", possibly "Receiptless — by
  IDent" once integrated) rather than being absorbed into the IDent name —
  same reasoning as Google keeping Gmail/Drive/Maps as named products
  under one umbrella instead of renaming everything "Google."

## Phase 2 — Productivity & Real-Time Comms

- Slack and Notion integrations
- Drive data aggregation (read + search across connected drives)
- Personal storage as remote storage: sync app for the user's *own* hardware
  acting as a personal node (not unlimited free cloud storage — see
  SECURITY.md for why that promise doesn't hold up)
- Video calls
- Voice calling across carrier/VoIP/radio channels, routed through the unified
  contact card
- AI assistant gains write actions (send message, schedule event) with
  per-action confirmation

**Exit criteria:** IDent can replace day-to-day switching between chat,
calendar, and drive apps for non-sensitive workflows.

## Phase 3 — Documents, Credentials & Educational Profile

First high-trust phase. Ships behind step-up authentication, separate from
the Phase 0 login key (see SECURITY.md).

- Documents & Credentials Vault: government ID, passport, driving license,
  enrollment letter, transcript, CV — encrypted, user-controlled sharing
  (time-boxed, revocable links instead of raw file exports)
- Educational Profile: structured education history from day zero (every
  school/program attended, dates, credentials) plus a living skills record
  that accumulates over time — distinct from the static documents above,
  designed to be queried ("what have I studied," "what skills have I picked
  up since 2023") rather than just stored
- LinkedIn profile sync
- Biometric enrollment for vault unlock (device-local matching only — raw
  biometric data never leaves the device, per SECURITY.md)

**Exit criteria:** a user can store and selectively share credential/education
data with a third party (e.g., an employer or school) without exporting the
raw document.

## Phase 4 — Health Profile

Second high-trust phase, kept isolated from Phase 3's vault (different
compliance regime, different key domain).

- Health profile: conditions, medications, latest blood tests, structured for
  a clinician to review quickly
- Doctor-facing share flow: scoped, time-limited, revocable — never a full
  account handoff
- Explicit non-goal for this phase: IDent stores and presents data, it does
  not interpret or advise on it

**Exit criteria:** a user can generate a doctor-ready summary in one action
and revoke access afterward.

## Phase 5 — Finance

Highest-liability phase — deliberately last. Bank and investment data is not
built in-house; it is integrated through licensed financial data aggregators
(the same category of partner Plaid/TrueLayer/Belvo occupy) so IDent never
holds raw banking credentials itself.

### Phase 5a — Accounts (read-only)

- Bank account aggregation (read-only balances/transactions via aggregator)
- Investment/stocks profile (read-only via brokerage APIs where available)
- Explicit non-goal: IDent does not custody funds or execute trades in this
  sub-phase

**Exit criteria:** net worth / accounts view is accurate and read-only, with
zero raw credentials stored by IDent.

### Phase 5b — Biometric payment authorization

Ships only after Phase 5a is stable and only for users who completed
biometric enrollment in Phase 3. Depends on both.

- Pay in-store or online using a fingerprint or face match instead of
  presenting a card or entering a PIN
- Mechanism: the on-device biometric match (same device-local template from
  Phase 3, never transmitted) authorizes release of a **tokenized payment
  credential** — a card-network or bank-rail token, provisioned through the
  existing licensed aggregator/card-network tokenization service from
  Phase 5a. The biometric replaces the "swipe/PIN" step; it does not become
  a new payment rail, and it never travels to the merchant or to IDent's
  servers
- Liveness/anti-spoof check required on every match (rejects photos, masks,
  recordings) — see SECURITY.md
- A non-biometric fallback (PIN or password) is mandatory, not optional —
  for accessibility, device damage, and injury edge cases
- Explicit non-goal: IDent does not become a card issuer or payment
  processor; it authorizes existing payment instruments, it doesn't create
  new ones

**Exit criteria:** a transaction can be completed end-to-end with a biometric
match, a working non-biometric fallback exists and is tested, and an audit
log shows the merchant/processor received a token — never raw biometric
data.

## Phase 6 — Physical World & Devices

This is where the "no keys" and "no lost belongings" pieces of the mission
ship. Depends on Phase 0's device-agent pattern and, for digital keys, on
Phase 3's biometric/vault infrastructure for the credential itself.

- Device location (find-my-device across the user's own devices)
- Remote device piloting — scoped, per-device, revocable permissions granted
  via a lightweight device agent (not a general remote-access backdoor)
- **Digital keys:** home, car, office, and hotel door unlock from the phone,
  using existing NFC/BLE/UWB digital-key standards (the same category Apple
  Wallet car keys and hotel key cards already use) rather than a proprietary
  lock protocol — IDent authorizes the unlock, it doesn't reinvent the lock
- **Belongings tracking:** locate a bag, a set of physical keys, or any
  item carrying a low-power Bluetooth tag — not just IDent-connected
  devices. See SECURITY.md for the privacy design this specifically
  requires (a crowd-sourced find network is easy to build in a way that
  enables stalking if done carelessly)
- Local sharing: QR code, Bluetooth, AirDrop-equivalent data transfer
- AI assistant gains device-control actions, always with explicit per-action
  confirmation for anything irreversible

**Exit criteria:** a user can locate and take a pre-approved remote action on
a second device, unlock an enrolled door with their phone, and locate a
tagged physical item — all from IDent on their primary device.

## Phase 7 — Life Logistics

- Address book (residence + other addresses, structured, reusable across
  other modules instead of re-entered per service)
- Transportation ordering (ride-hailing integration)
- Shipment tracking (carrier integrations, unified tracking view)
- Location features building on Phase 6's device location

## Phase 8 — Personal & Discovery

Lowest-stakes phase, ships whenever convenient — nothing else depends on it.

- Music (streaming service integration, not hosting)
- Gaming profile (aggregated profile/stats across platforms)
- News feed
- Research profile (papers/topics followed, reading list)
- Browsing data (opt-in history/bookmark aggregation, local by default)

## Phase 9 — Deviceless / Alternative Access

Answers a different question than Phases 0–8: not "what does IDent do," but
"what happens when you have no phone, no laptop, nothing with you at all,
and still need to get in." Ships last, deliberately — it's the highest-risk
surface in the entire system (public/borrowed terminals are inherently
hostile environments), and it only makes sense to build once the personal-
device trust model from every earlier phase has been running and proven.
This is not meant to make people give up their devices day-to-day — it's
resilience for the moment they don't have one on them.

Two tiers, matched to the trust-tier model already used everywhere else:

- **Low/Medium tier, any public terminal:** username + password/passphrase
  only, no biometric, no hardware. Enough to read your inbox or calendar
  from a library computer or a borrowed phone. Nothing from this session is
  ever cached on the terminal — see ARCHITECTURE.md.
- **High/Critical tier (vault, digital keys, biometric payment), the
  recommended path:** password/passphrase **plus a small portable hardware
  token** — pocket/keychain-sized, not a phone or laptop, closer to a
  physical door key than a device. This preserves the existing on-device
  local-matching security model (see SECURITY.md) instead of weakening it,
  while still meaning the user isn't carrying a phone or laptop.
- **High/Critical tier, true zero-device fallback (opt-in, explicitly
  higher-risk):** password/passphrase plus a server-side verified biometric
  match, using biometric template-protection techniques (cancelable/secure-
  sketch templates, never raw or reversible data) rather than the on-device
  templates used everywhere else in the system. This is a materially
  different security posture than the rest of IDent and is documented as
  such in SECURITY.md — it exists for people who genuinely have nothing on
  them, not as the default recommended path.

**Exit criteria:** a user with zero personal devices can read Low/Medium
data from any public terminal, and — carrying only a keychain-sized token —
complete a High-tier action (open a digital key, view a vault document, pay
with biometric authorization) without the terminal retaining any credential,
key, or cached data after the session ends.

## Phase 10 — Telecommunications

The longest-horizon, most explicitly optional phase in this roadmap. Everything
before it (Eras I–IV) has to be stable *and profitable* first — this phase is
gated on that, not on the calendar. It exists because Phase 2's "voice calling
across carrier/VoIP/radio channels" and Phase 0's username-not-phone-number
identity already point this direction; this phase is what it looks like to
walk that direction all the way, in small reversible steps instead of one
leap.

**The proposition, stated precisely:** IDent's `@username` becomes a
communications identity, resolving to whichever underlying channel is live
(IDent-to-IDent, VoIP, cellular, work line, temporary number) — the
traditional phone number stays underneath as the interoperability layer the
rest of the world still needs, the way an IP address still sits underneath a
domain name. IDent is not trying to replace the phone number; it's trying to
stop being the thing a person has to remember.

Seven sub-phases, each a materially bigger commitment than the last. Skipping
ahead is not available as an option, same as everywhere else in this roadmap —
see SECURITY.md's framing and BOOTSTRAP.md's milestone gates.

- **T0 — Communications identity.** Purely software: `@username` resolves to
  the right endpoint (app, browser, temporary device, or a plain phone
  number) using infrastructure this repo already owns from Phase 0/2. No new
  regulatory surface.
- **T1 — VoIP provider.** IDent-to-IDent calling, video, voicemail; PSTN
  bridging only through an existing licensed provider. Still not a carrier of
  any kind.
- **T2 — Telecom reseller / eSIM partner.** IDent sells eSIM/data/voice/SMS
  bundles; a licensed operator physically carries every bit of traffic. This
  is the first sub-phase involving a real commercial telecom partner and
  therefore the first one worth revisiting only after Phase 1's monetization
  wedge has proven users will pay for something from this repo at all (see
  BOOTSTRAP.md's milestones).
- **T3 — MVNO.** IDent buys wholesale network capacity; the user's eSIM
  account is attached to their IDent identity rather than the reverse. This is
  the first sub-phase that makes "IDent is a telecom provider" literally
  true, and the first one requiring the local regulator-facing setup below.
- **T4 — Programmable carrier integration.** Building on standardized operator
  network APIs (the GSMA Open Gateway / CAMARA family: KYC/SIM-swap signals,
  device reachability, location, quality-on-demand) for identity-aware
  connectivity — e.g., requesting better QoS for a live consult, or using
  network-level signals as an additional fraud/account-takeover check. Ships
  only where a partner operator actually exposes these APIs.
- **T5 — Number abstraction.** `@username` becomes the thing people actually
  give out; the phone number becomes an internal routing detail most users
  never see, the same relationship a domain name has to an IP address.
- **T6 — Full MVNO / regional telecom operator.** Subscriber management,
  eSIM provisioning, billing, IMS integration, roaming agreements,
  interconnect, numbering, fraud prevention, dedicated customer service —
  run by telecom professionals IDent has hired by this point, not by AI
  guidance. This sub-phase marks where "AI-assisted solo build" stops being
  the operating model, honestly, same as Phase 3–5 already do in BOOTSTRAP.md.
- **T7 — Facilities-based network (explicit non-goal by default).** Owning
  spectrum, towers, or core radio infrastructure is not required to be a
  telecom company in any way that matters for IDent's mission — a
  software-heavy MVNO gets the `@username`-as-identity outcome without the
  capital intensity of physical radio infrastructure. Only reconsider this if
  the economics become exceptionally and specifically attractive; default
  posture is "never."

**Regulatory reality, stated plainly:** from T3 onward, telecom licensing is a
real regulator relationship (e.g., Egypt's NTRA requires a licensed Egyptian
entity for services that require licensing at all), plus carrier interconnect
and roaming agreements. AI guidance can build the software stack; it cannot
manufacture spectrum, a license, or an interconnect agreement — those need
people, an actual company, and money earned from the eras below this one.

**Exit criteria (T3, the first sub-phase that matters most):** a user can hold
an IDent-branded eSIM whose account is keyed to their IDent identity rather
than a phone number, on a wholesale-capacity agreement with a licensed
operator, with T0–T2 already stable in production for existing users.

---

## Cross-cutting: AI Assistant

The assistant is not a separate phase — it grows in scope alongside the data
it's allowed to touch:

| Phase | Assistant capability |
|---|---|
| 1 | Read-only Q&A over inbox/calendar/contacts, plus negotiated importance/distraction filtering (transparent, overridable per item or per rule, nothing auto-hidden or deleted) |
| 2 | Write actions with per-action confirmation |
| 3–5 | Read access to vault/health/finance only with explicit, scoped, revocable grants — never blanket access |
| 6 | Device-control actions, confirmation required for anything irreversible |

**This is also the paid feature.** The Phase 1 assistant, gated behind a
recurring per-user fee with an explicit privacy commitment (never used to
train shared models, encrypted history, isolated per-user context — see
SECURITY.md), is the monetization wedge for the whole bootstrap plan. See
[BOOTSTRAP.md](BOOTSTRAP.md) for the full reasoning, what a small fee can
and can't fund, and what "private" is honestly able to mean.

## Explicit non-goals

- **Not** a "100% free unlimited storage" claim — Phase 2's personal storage
  is the user's own hardware acting as a node, not manufactured capacity.
- **Not** a custodial bank or broker — Phase 5 integrates existing licensed
  institutions, it doesn't become one.
- **Not** a general remote-access tool for arbitrary devices — Phase 6's
  device piloting only works on devices the user has explicitly enrolled.
- **Not** a proprietary lock/key protocol — Phase 6's digital keys ride on
  existing NFC/BLE/UWB digital-key standards; IDent is the authorization
  layer, not a lock manufacturer.
- **Not** an open crowd-sourced tracking network by default — Phase 6's
  belongings tracking only reports locations to the item's own owner,
  under the privacy model in SECURITY.md, not to anyone in range.
- **Not** a claim that zero-device access (Phase 9) is equally secure to
  on-device access — the server-verified biometric fallback is a real,
  documented downgrade in security posture, offered as an explicit opt-in
  for people with nothing on them, not as a preferred everyday path.
- **Not** an attempt to become a facilities-based carrier — Phase 10 stops
  by default at MVNO (wholesale capacity on a licensed partner's network);
  owning spectrum or radio infrastructure (T7) is an explicit non-goal
  unless the economics are exceptional, not a natural end state to grow into.
- **Not** a replacement for phone numbers — Phase 10's `@username` routing
  sits *above* the phone number the way a domain name sits above an IP
  address; the number keeps existing underneath for interoperability with a
  world that still requires it.
