# IDent Roadmap

This roadmap sequences delivery by **trust tier**, not by feature popularity.
Modules that only aggregate low-stakes data (news, music) ship early and
loosely coupled. Modules that touch money, government identity, biometrics,
or health data ship later, behind stronger isolation, and often depend on
licensed third-party partners rather than being built from scratch — see
[SECURITY.md](SECURITY.md) for why.

Each phase assumes the previous phase's foundations are in place. Nothing
here is a committed timeline — it's a dependency-ordered build sequence.

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

**Exit criteria:** daily-driver usable as a notification/inbox aggregator,
with a working, honestly-described private-assistant upsell.

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

---

## Cross-cutting: AI Assistant

The assistant is not a separate phase — it grows in scope alongside the data
it's allowed to touch:

| Phase | Assistant capability |
|---|---|
| 1 | Read-only Q&A over inbox/calendar/contacts |
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
