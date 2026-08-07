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

## Device piloting & location (Phase 6)

A lightweight **device agent** runs on each enrolled device (not the primary
IDent app — a separate, minimal-permission companion). It:
- authenticates to Identity Core with its own device credential, scoped to
  that device only
- exposes a fixed, small action set (locate, lock, run a pre-approved
  script/shortcut) — never arbitrary remote code execution
- requires the action to be explicitly enrolled and approved per device
  ahead of time; there is no "pilot any device" mode

## Personal storage as remote storage (Phase 2)

This is a sync/backup node the user runs on hardware they already own
(a spare phone, a home server, a NAS), not server-side storage IDent
provisions for free. The client encrypts before syncing, so the node stores
ciphertext regardless of what hardware it runs on.

## Data model note

Every module's records carry the user's IDent username as the foreign key,
not a phone number or email — consistent with the identity requirement in
Phase 0. Phone/email remain optional, revocable recovery contacts only.
