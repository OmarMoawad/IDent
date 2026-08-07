# IDent

**One identity. Every part of your digital and physical life, unified.**

IDent is a cross-platform personal hub that consolidates messaging, notifications,
finance, productivity tools, identity documents, health records, device control,
logistics, and personal data — all addressable under a single self-chosen
username and password, not tied to a phone number.

> **Status: concept / pre-build.** This repo currently holds the product
> roadmap and system design, not implementation. See the docs below before
> writing any code against this plan.

## Why

Most of a person's digital life is scattered across dozens of apps and
accounts, each with its own login, its own notification stream, and its own
security posture. IDent's goal is a single, user-owned front door — with the
understanding that the modules carrying the most sensitive data (identity
documents, health, finance, biometrics) need materially stronger isolation
and compliance handling than the modules carrying the least (music, news,
gaming profile).

## Documents

| Doc | Purpose |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Phased delivery plan across all modules, in build order |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design: identity core, API layer, module boundaries, integrations |
| [SECURITY.md](SECURITY.md) | Threat model, encryption approach, and compliance load per module |
| [BOOTSTRAP.md](BOOTSTRAP.md) | Whether this is buildable without capital, and the paid-private-assistant monetization model |

## Module map

- **Identity Core** — username/password identity, biometric enrollment, session & key management
- **Communications Hub** — unified inbox (messages, notifications), contact cards, voice/video calling across networks, Slack
- **Productivity** — calendar, reminders, Notion, drive data, personal/virtual storage
- **Documents & Credentials Vault** — government ID, passport, driving license, enrollment letter, transcript, CV, LinkedIn
- **Educational Profile** — full education history from day zero (every school/program attended) plus a living record of skills acquired over time
- **Health Profile** — blood tests and records structured for clinician access
- **Finance** — bank accounts, investments/stocks, biometric payment authorization (pay in-store/online with a fingerprint or face match instead of a card or PIN)
- **Devices & Physical World** — remote device piloting, device location, QR/Bluetooth/AirDrop sharing
- **Life Logistics** — transportation booking, shipment tracking, addresses, location features
- **Personal & Discovery** — music, gaming profile, news, research profile, browsing data
- **AI Assistant Layer** — cross-cutting assistant with scoped access to the above

Full sequencing and rationale for this ordering is in [ROADMAP.md](ROADMAP.md).
