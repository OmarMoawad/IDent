# IDent Architecture

High-level system design. This is intentionally at the "boxes and boundaries"
level — enough to make Phase 0 buildable and to make the trust-tier
separation in ROADMAP.md concrete, not a full technical spec.

## Guiding constraint

**A breach of one module must not cascade into another.** News-feed data and
government ID scans cannot share a key hierarchy, a database, or (ideally) an
incident-response blast radius. Every design choice below exists to enforce
that.

## Layers

```
Client apps (iOS / Android / Web / Desktop)
        |
   API Gateway / BFF
        |
 +------+-------+-------------------+-------------------+
 |              |                   |                    |
Identity   Domain services   Integration adapters   Vault subsystem
  Core     (comms, calendar,  (Slack, Notion, banks,  (E2E encrypted,
           storage, devices,  LinkedIn, carriers,      zero-knowledge)
           logistics, social) shipping, ride-hailing,
                               music, gaming APIs)
```

### Client apps

Thin clients. Hold session tokens and the user's derived encryption keys;
push as much logic as possible server-side except anything touching raw
key material or biometric matching, which stays on-device.

### Identity Core

- Username + password auth, independent of phone number or email as the
  primary identifier (both can be linked as recovery factors, neither is
  required to log in)
- Passkey/WebAuthn as the recommended default; password remains a fallback
- Issues short-lived session tokens; every domain service validates tokens
  against Identity Core, never trusts a token blindly
- Owns the **key hierarchy**: a randomly generated, client-side **Account
  Master Key (AMK)**, not derived from the password or passkey. The AMK is
  wrapped by separate key-encryption keys (KEKs) — one per authorized
  factor (password-derived, passkey-derived where the authenticator
  exposes a stable secret, device-bound) — so any one factor unwraps the
  same AMK, and rotating a leaked factor means rewrapping, not
  re-deriving everything. A deliberately designed recovery path (its own
  wrapped copy, its own factor) covers the lost-device-and-password case
  rather than assuming one of the above always survives. Per-module keys
  unwrap from the AMK, not a single master key that decrypts everything at
  once (this is what makes step-up auth for Phase 3–5 modules meaningful,
  see SECURITY.md). This is deliberately not "derive a root key from the
  password/passkey" — that doesn't hold for passkeys in general (a WebAuthn
  ceremony doesn't hand back a reproducible secret by default) and couples
  every module's keys to one factor never being rotated.

### Domain services

One service per module family (communications, productivity, devices,
logistics, personal/discovery). Each:
- has its own datastore — no shared tables across modules
- only accepts tokens scoped to its own module
- talks to Integration Adapters for anything external, never calls a
  third-party API directly

**Current phase note:** through Phase 0–2, this is a **modular monolith**
— one Fastify API, one Postgres instance, module boundaries enforced as
separate schemas/packages with no cross-schema queries, not as separately
deployed services. "One service per module family" above is the target
end-state once a specific module's trust/scale needs actually demand
isolated deployment (Vault-backed modules are the likely first candidate).
Don't stand up separate services or datastores prematurely just to match
this diagram literally.

### Integration adapters

One adapter per external system (Slack, Notion, a given bank aggregator,
LinkedIn, a given carrier API, shipping carriers, ride-hailing, music/gaming
platforms). Adapters normalize external data into IDent's internal schema and
are the only components allowed to hold third-party API credentials —
scoped per user, never shared across users.

### Vault subsystem

Backs the highest-trust modules: Documents & Credentials, Educational
Profile, Health Profile, Finance, and biometric enrollment data.

- Client-side encryption before anything is uploaded — the server stores
  ciphertext it cannot read (zero-knowledge)
- Per-document keys, wrapped by the module-specific key from Identity Core's
  key hierarchy
- Sharing (e.g., a doctor, an employer) works via **time-boxed, revocable
  grants**: the vault re-wraps a specific document key for the recipient's
  public key, never hands over the user's key or a raw file export by default
- Biometric data specifically: only a device-local match template is used
  for on-device unlock; raw biometric captures are never uploaded to the
  vault or transmitted off-device

**AI assistant access to vault-backed data** (ROADMAP.md's cross-cutting
AI Assistant table, Phase 3–5: "scoped, revocable grants") follows this
path, not a standing exception to zero-knowledge storage:

```
User approves a scoped, time-boxed grant (e.g. "summarize this lab result")
        |
Client decrypts only the granted document(s) locally
        |
Plaintext sent directly to the inference call for that single request
 (no-retention, no-training terms per SECURITY.md's AI Assistant Privacy)
        |
Response returned to user; no plaintext or grant persists server-side
 beyond the single request
```

IDent's servers still never hold vault plaintext or a key capable of
decrypting it — the grant authorizes a client-side decrypt-and-forward for
one request, not a server-side read path into the vault.

## Biometric payment authorization (Phase 5b)

Reuses the Phase 3 biometric enrollment — there is no second, payment-specific
biometric database.

```
On-device biometric match (local template, Phase 3)
        |  (match = yes/no + liveness check, nothing biometric leaves device)
        v
Local secure element releases a payment token
 (network/aggregator-issued, scoped to one transaction or a short window)
        |
        v
Card network / bank rail (via Phase 5a's licensed aggregator/tokenization
 service) processes the transaction as it would any tokenized tap-to-pay
```

Key points:
- The biometric match happens on the user's own device (secure enclave /
  equivalent), the same as unlocking the vault in Phase 3 — it is an
  authorization gate, not a payment mechanism in itself
- What reaches the merchant or processor is a **token**, structurally
  identical to what Apple Pay/Google Pay already send — never a biometric
  template, never raw fingerprint/face data
- IDent's servers see "transaction authorized" events for the user's own
  audit log, not biometric data and not full card/account numbers
- A merchant-side biometric terminal (e.g., a hand/face scanner at a
  register) is a separate trust boundary from a user's own device and is
  out of scope until Phase 5b's device-local model is proven — see
  SECURITY.md

## Device piloting & location (Phase 6)

A lightweight **device agent** runs on each enrolled device (not the primary
IDent app — a separate, minimal-permission companion). It:
- authenticates to Identity Core with its own device credential, scoped to
  that device only
- exposes a fixed, small action set (locate, lock, run a pre-approved
  script/shortcut) — never arbitrary remote code execution
- requires the action to be explicitly enrolled and approved per device
  ahead of time; there is no "pilot any device" mode

## Digital keys (Phase 6)

A digital key is a credential, not a new lock protocol. IDent provisions and
stores the credential (in the Phase 3 vault's key hierarchy, so door keys
sit in the same trust tier as the documents vault), then hands it off to the
phone's existing secure hardware to actually perform the NFC/BLE/UWB unlock
handshake with the lock — the same mechanism Apple Wallet car keys and
CCC Digital Key-compliant locks already use. IDent never implements its own
lock firmware or protocol; it authorizes, stores, and lets the user revoke a
door credential the way it already does for documents.

- Revocation is immediate and lock-side: losing a phone means revoking the
  key from any other logged-in device, not rekeying the physical lock
- Each enrolled lock is its own credential — losing access to one door
  (lost phone, revoked key) doesn't cascade to others, same isolation
  principle as the rest of the vault

## Belongings tracking (Phase 6)

A low-power Bluetooth tag (user-owned hardware, not IDent-manufactured)
broadcasts an identifier; nearby IDent-running devices — belonging to
*anyone*, not just the tag's owner — relay an encrypted, anonymized sighting
back to the owner. This is the same crowd-sourced model Apple's Find My
network uses, and it inherits the same privacy requirement: a relaying
device must not be able to identify what it relayed or who owns it, and the
tag's identifier must rotate frequently enough that it can't be used to
track the *tag* by anyone other than its owner. See SECURITY.md — this
module is easy to build unsafely (a static ID broadcasting nonstop is a
stalking tool) and must not ship without the rotating-identifier design.

## Deviceless / alternative access (Phase 9)

Everything described so far assumes the user has an enrolled device with a
secure enclave holding their keys and biometric template. This section
covers what happens when that assumption doesn't hold — no phone, no
laptop, nothing enrolled at hand.

```
Public terminal / borrowed device (untrusted — nothing persists here)
        |
   Access broker  <-- new component, exists only for this flow
        |
        +--> Low/Medium tier: password/passphrase only
        |         -> ordinary domain services (inbox, calendar, etc.)
        |
        +--> High/Critical tier, recommended: password/passphrase
        |    + portable hardware token (FIDO2-class, keychain-sized)
        |         -> token performs local key/biometric matching itself,
        |            same guarantee as an enrolled phone, just smaller
        |
        +--> High/Critical tier, zero-device fallback (opt-in):
                 password/passphrase + server-verified protected
                 biometric template
                 -> Identity Core's degraded-trust path, isolated
                    key domain, see SECURITY.md
```

Design rules that make this safe to add rather than a regression on
everything above it:

- **The access broker is stateless per session.** No key, token, or
  credential is ever written to the terminal's local storage; the session
  exists only in the broker's memory for its duration and is destroyed on
  logout or timeout. Tab close is not a guaranteed trigger — the browser
  and OS control that, not IDent — so logout/timeout are the enforced
  boundary, and High/Critical flows must not be described to users as
  protected by "closing the tab"
- **The portable hardware token is the default recommendation for
  High/Critical tier**, specifically because it preserves the existing
  on-device local-matching model (ARCHITECTURE.md's guiding constraint at
  the top of this doc) instead of weakening it — it's a smaller "device,"
  not a different trust model
- **The server-verified biometric fallback is architecturally isolated**
  from the rest of Identity Core's key hierarchy — it has its own key
  domain, so a compromise of this (newer, higher-risk) path cannot unlock
  data protected by the on-device model, and vice versa
- **Kiosk/partner terminals, if IDent operates or certifies any, are a
  distinct trust boundary from a "any borrowed phone" flow** — a certified
  terminal can be held to tamper-evidence and no-logging requirements a
  random borrowed phone can't, and the UI should make clear to the user
  which kind of terminal they're on before they authenticate

## Personal storage as remote storage (Phase 2)

This is a sync/backup node the user runs on hardware they already own
(a spare phone, a home server, a NAS), not server-side storage IDent
provisions for free. The client encrypts before syncing, so the node stores
ciphertext regardless of what hardware it runs on.

## Data model note

Every account gets an immutable, opaque `identity_id` (UUID/ULID),
generated once at account creation. All internal records — across every
module, adapter, and future service — reference `identity_id`, never a
phone number, email, or username. The public `@username` is a unique,
mutable, human-readable alias resolved to `identity_id` through Identity
Core; it must never serve as a database primary/foreign key, a
cryptographic identity, or (once Phase 10 exists) a telecom subscriber
identifier. Renaming a username updates one row in Identity Core's alias
table, nothing downstream. Phone/email remain optional, revocable recovery
contacts only.
