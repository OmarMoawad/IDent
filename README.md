# IDent

**Walk out the door with nothing but yourself.**

IDent's mission: let a person walk, travel, and commute without carrying a
wallet, a set of keys, or a folder of documents. Your identity — documents,
door/car keys, payment, and the whereabouts of what you're carrying — lives
under one self-chosen username and password, not tied to a phone number, and
travels with you on a device (and eventually a biometric) instead of in your
pockets.

> **Status: concept / pre-build.** This repo currently holds the product
> roadmap and system design, not implementation. See the docs below before
> writing any code against this plan.

## Why

Leaving the house today still means patting your pockets for three physical
things: a wallet (payment + ID), a set of keys (home, car, office), and
sometimes a folder of documents (for an appointment, a border crossing, an
enrollment office). Each of those is solvable with a phone already — Apple
Pay replaces the wallet, digital car keys exist, ID wallets are emerging —
but they're scattered across separate apps and vendors with no single owner.
IDent's goal is to be the one place all three live, under a single
user-owned identity, with the understanding that the modules carrying the
most sensitive data (identity documents, health, finance, biometrics, door
keys) need materially stronger isolation and compliance handling than the
modules carrying the least (music, news, gaming profile). Everything else in
this repo — comms hub, productivity, health, personal data — exists around
that core mission, not instead of it.

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
- **Devices & Physical World** — remote device piloting, device location, digital keys (home/car/office door unlock from your phone instead of a physical key), belongings tracking (find a bag or item, not just a device), QR/Bluetooth/AirDrop sharing
- **Life Logistics** — transportation booking, shipment tracking, addresses, location features
- **Personal & Discovery** — music, gaming profile, news, research profile, browsing data
- **AI Assistant Layer** — cross-cutting assistant with scoped access to the above

Full sequencing and rationale for this ordering is in [ROADMAP.md](ROADMAP.md).
