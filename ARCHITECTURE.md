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
- Owns the **key hierarchy**: one root key derived from the user's
  password/passkey, which unwraps per-module keys — not a single master key
  that decrypts everything at once (this is what makes step-up auth for
  Phase 3–5 modules meaningful, see SECURITY.md)

### Domain services

One service per module family (communications, productivity, devices,
logistics, personal/discovery). Each:
- has its own datastore — no shared tables across modules
- only accepts tokens scoped to its own module
- talks to Integration Adapters for anything external, never calls a
  third-party API directly

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

## Personal storage as remote storage (Phase 2)

This is a sync/backup node the user runs on hardware they already own
(a spare phone, a home server, a NAS), not server-side storage IDent
provisions for free. The client encrypts before syncing, so the node stores
ciphertext regardless of what hardware it runs on.

## Data model note

Every module's records carry the user's IDent username as the foreign key,
not a phone number or email — consistent with the identity requirement in
Phase 0. Phone/email remain optional, revocable recovery contacts only.
