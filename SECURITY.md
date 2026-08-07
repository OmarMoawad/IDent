# IDent Security & Compliance Model

IDent's module list spans the full range of data sensitivity — a news feed
sits next to a passport scan sits next to a bank balance. Treating all of it
under one flat security model would be a mistake. This doc lays out the
per-tier approach and flags where the compliance burden is real, not
theoretical.

## Trust tiers

| Tier | Modules | Data if breached |
|---|---|---|
| Low | Music, gaming profile, news, research profile, browsing data | Embarrassing, rarely dangerous |
| Medium | Comms hub, calendar, Slack/Notion, drive data, contacts | Privacy loss, social engineering risk |
| High | Documents & Credentials Vault, Educational Profile, Health Profile | Identity theft, discrimination, medical privacy law exposure |
| Critical | Finance, biometrics, device piloting | Direct financial loss, irreversible physical/account access |

Each tier gets a different auth requirement, a different key domain, and a
different incident-response plan. A Critical-tier breach must not be able to
touch Low-tier data or vice versa — see the module isolation design in
ARCHITECTURE.md.

## Authentication model

- **Base session** (Identity Core login): unlocks Low and Medium tier modules
- **Step-up auth** (re-enter password/passkey + device-local biometric):
  required to unlock High and Critical tier modules, and expires on a much
  shorter window than the base session
- No single credential decrypts every module at once — the key hierarchy in
  ARCHITECTURE.md enforces this structurally, not just as a UI gate

## Encryption

- All traffic: TLS in transit, no exceptions
- Vault-backed modules (High/Critical tier): client-side E2E encryption,
  zero-knowledge server storage — IDent's own servers cannot read vault
  contents even under legal compulsion, only the user (or a grant recipient
  holding a re-wrapped key) can
- Biometrics specifically: raw fingerprint/face data is **never** collected
  or stored centrally. Matching happens on-device against a local template,
  consistent with how Apple/Google's platform biometric APIs already work.
  Centralizing raw biometric data would be a single point of catastrophic,
  irreversible failure — if a password leaks you rotate it, if a fingerprint
  template leaks you can't reissue a fingerprint.

## "100% full E2E encryption" — what that promise can and can't cover

E2E encryption protects data at rest and in transit against IDent's own
servers and infrastructure. It does **not** protect against:
- a compromised client device (E2E is only as strong as the endpoint)
- the user's own password if it's weak or reused
- data the user explicitly shares with a third party (a doctor who receives
  a health summary now holds a copy outside IDent's control)

The roadmap's "time-boxed, revocable grant" pattern (ARCHITECTURE.md) is the
mitigation for that last point — it limits exposure duration and scope, it
doesn't eliminate the fact that shared data is, by definition, shared.

## Compliance load by module (why Phases 3–5 are sequenced last)

- **Finance (Phase 5):** handling bank credentials or transaction data
  directly triggers PCI-DSS and, depending on jurisdiction, money-transmitter
  or open-banking licensing. The roadmap avoids this by integrating through
  already-licensed aggregators (Plaid/TrueLayer/Belvo-category partners)
  rather than IDent becoming a regulated financial entity itself.
- **Health Profile (Phase 4):** HIPAA (US) or equivalent health-data
  regulations elsewhere apply the moment health data is stored and shared
  with a clinician, regardless of company size. Requires a signed
  data-processing agreement pattern with any integrated provider and an
  audit log of every access/share event.
- **Documents & Credentials Vault (Phase 3):** government-issued ID storage
  intersects KYC/AML expectations if the data is ever used to verify
  identity for a third party (e.g., "share my ID with this employer").
  Storage alone is lower-risk than verification; the roadmap treats IDent as
  a storage/sharing layer, not an identity-verification authority.
- **Device piloting (Phase 6):** unscoped remote device control is
  functionally similar to remote-access malware from a threat-model
  standpoint. The fixed-action-set, per-device-enrollment design in
  ARCHITECTURE.md exists specifically to keep this from being a general
  backdoor — enrollment must be an explicit, auditable, revocable act.

## Biometric payments (Phase 5b) — specific risks

Biometric payment carries two risk classes beyond generic biometric storage
(already addressed above by never centralizing raw biometric data):

- **Spoofing:** a fingerprint or face is not a secret the way a PIN is — it
  can be photographed, lifted, or 3D-printed. Liveness/anti-spoof detection
  on every match is a hard requirement, not a nice-to-have, and should be
  re-evaluated against known bypass techniques on a regular cadence, not
  built once and left alone.
- **Irreversibility:** if a biometric authorization mechanism is defeated,
  the user cannot rotate their fingerprint the way they'd rotate a card
  number. This is why Phase 5b authorizes a *revocable token*, not a
  standing credential — compromising one merchant transaction's token does
  not compromise the underlying account, and tokens can be revoked/reissued
  without touching the biometric enrollment itself.
- **Mandatory fallback:** regulators and accessibility standards both
  expect a non-biometric path (PIN/password) for anyone who cannot use
  biometric auth reliably — injury, certain disabilities, device damage.
  Treat this as a launch blocker for Phase 5b, not a post-launch add-on.

## Compliance load — biometric-specific regulation

Beyond the PCI-DSS load already inherited from Phase 5a's payment rails,
biometric data triggers its own regulatory category in most jurisdictions —
e.g., BIPA in Illinois, GDPR's "special category data" classification (EU),
and similar biometric-specific statutes elsewhere. These typically require
explicit informed consent for biometric processing, a defined retention/
deletion policy, and in some jurisdictions a private right of action if
violated. IDent's device-local-only biometric model (no centralized
biometric storage, ever) substantially reduces this exposure but does not
eliminate the consent/disclosure obligations — legal review is required
before Phase 3 enrollment ships, not just before Phase 5b.

## Incident response principle

Because each trust tier has its own key domain, a credible response to "your
Low-tier module was breached" is "rotate that module's key, no other module
is affected." That containment only holds if module isolation from
ARCHITECTURE.md is actually enforced in the datastore and key-management
implementation — it is a design requirement, not an incidental benefit.

## Explicit non-goals

- Not claiming regulatory-compliant status by having this document — it
  describes the target model; actual HIPAA/PCI/KYC compliance requires
  audits, legal review, and possibly licensed partners per jurisdiction
  before those modules handle real user data.
- Not a promise that E2E encryption makes shared data (Phase 3–4 grants)
  immune to misuse by the party it was shared with.
