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
  - Built as of session 12 (see IDent_STATE.md): a distinct `elevatedUntil`
    field layered onto the existing base session row (not a second
    session/token), obtained by re-entering password, passkey, or recovery
    code — `POST /identity/elevate/{password,recovery,webauthn/options,
    webauthn/verify}` reuse the exact same verify paths login already uses.
    A 5-minute elevation window, enforced server-side on every request via a
    Fastify `preHandler` hook (`requireElevatedSession` in
    `identity/elevation.ts`) — never a client-supplied trust-tier claim.
    Device-local biometric isn't implemented — it depends on Phase 3
    enrollment, which doesn't exist yet. No real High/Critical-tier route
    exists to protect yet either (Phase 3+), so a synthetic demo route
    (`GET /identity/demo/high-tier-secret`) currently proves the mechanism;
    delete it once a real one ships.
  - **Session-token rotation on elevation** (added same session, after a
    2026-08-11 external review flagged the gap): elevation used to be a
    pure attribute of the existing session row, so a *stolen* pre-elevation
    bearer token would silently inherit elevation the moment the legitimate
    owner elevated that same session — no re-authentication of the
    attacker's own required. Every `elevate*` call now also rotates the
    session's bearer token (`store.ts`'s `elevateSessionById` sets a new
    `tokenHash` in the same update) and returns the new raw token to the
    caller; the old token stops matching any session immediately, not just
    for elevated routes. Standard OWASP session-management guidance
    (regenerate the session identifier on a privilege change), applied here
    rather than left as a known gap.
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
- **Digital keys (Phase 6):** a lost or stolen phone becomes a physical
  break-in risk if key revocation isn't instant and doesn't require the
  physical lock itself to cooperate. Revocation must work purely from
  another logged-in device (see ARCHITECTURE.md) — a design that depends on
  reaching the lock to revoke access is a design that fails exactly when a
  user most needs it to work.

## Belongings tracking (Phase 6) — the stalking risk

A crowd-sourced find-network for physical items (ARCHITECTURE.md) is
straightforward to build unsafely: a Bluetooth tag with a static,
unencrypted identifier is functionally a tracking beacon anyone nearby can
follow, not just its owner. This is not a hypothetical — this exact failure
mode is why Apple and Google jointly published an industry unwanted-tracker
detection standard after AirTags were used for stalking. Non-negotiable
requirements before this module ships:
- Tag identifiers rotate on a short interval, so a static ID can't be logged
  and followed over time by anyone but the owner
- Relaying devices (any nearby IDent user's phone) never learn what they
  relayed or whose tag it was — only the owner's own account can decrypt a
  sighting
- **Unwanted-tracker detection:** a phone that has been traveling near an
  unfamiliar tag that isn't the phone owner's should be alerted, mirroring
  the industry standard above — this protects people who don't use IDent at
  all from being tracked by someone who does
- The exit criteria for this module includes the anti-stalking design, not
  just "tag can be located" — a version without it should not ship, full
  stop

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

## Deviceless access (Phase 9) — a real, documented downgrade for one path

Everything above this point assumes a biometric template lives only on a
device the user controls. Phase 9's zero-device fallback breaks that
assumption on purpose, for people who genuinely have no phone, laptop, or
token on them — and it needs to be named as a different security posture,
not folded into the rest of the model as if it carries the same guarantees.

**What changes:** to verify identity with nothing but "something you know"
(a password) and "something you are" (a biometric) — no device, no token —
the biometric match has to happen somewhere other than hardware the user
physically holds. That means a server-side comparison, which means a
server-side template, full stop. There's no way to offer true zero-device
biometric access without this trade — anyone who claims otherwise for a
zero-device product is not describing the actual mechanism.

**How the exposure is bounded, not eliminated:**
- The server-side template uses biometric template-protection techniques
  (cancelable biometrics / secure sketch / fuzzy vault schemes) — the stored
  artifact is not the raw biometric and is not reversible to it, but it is
  categorically closer to centralized biometric storage than anything else
  in this system, and should be described to users that way
- This path is opt-in and separately consented from the base biometric
  enrollment in Phase 3 — a user who enrolls a fingerprint for on-device
  unlock has not thereby agreed to a server-side copy existing anywhere
- It sits in its own isolated key domain (ARCHITECTURE.md) so that if this
  specific path is ever compromised, it does not unlock the on-device model
  used by every other phase
- It defaults to Low/Medium tier data; reaching High/Critical tier through
  this path specifically (vault, keys, payment) should require an
  additional factor beyond password + biometric — e.g., a recovery code
  set up in advance — precisely because this is the weakest link in the
  whole system and the one most attractive to attack

**Kiosk/public-terminal threats specific to this phase:** shoulder-surfing
a password at a public terminal, hardware skimmers on a compromised kiosk,
and malware on a genuinely "borrowed" (not IDent-certified) device are all
live threats that don't exist in the personal-device model. The no-
persistence design in ARCHITECTURE.md (nothing written to the terminal,
session dies on logout/timeout) mitigates lingering exposure but does not
protect against a terminal that was already compromised before the session
started — that risk is inherent to using untrusted hardware and should be
disclosed to users as exactly that, not designed around as if it can be
fully engineered away.

## AI Assistant Privacy

The paid assistant tier (BOOTSTRAP.md) is only worth charging for if its
privacy claim is precise rather than a slogan. "100% private" needs the same
scrutiny already applied to "100% full E2E encryption" above.

**What can be genuinely guaranteed:**
- Conversation history encrypted at rest, under the same per-user key domain
  as the rest of a user's Medium-tier data — IDent's own database storage
  cannot be read in bulk
- No use of user conversations to train shared or future models — this
  needs to be a contractual term with whatever inference provider is used,
  not an assumption, since many consumer AI products reserve training
  rights by default
- Strict per-user context isolation — one user's assistant never has access
  to another user's data, and there is no cross-user aggregation without
  separate, explicit, opt-in consent
- User-controlled deletion/export of assistant history at any time

**What can't honestly be claimed at Phase 1:** if the assistant calls a
third-party inference API (the realistic Phase 1 approach — running a
competitive model on your own infrastructure is not zero-capital), that
provider necessarily processes each query transiently to generate a
response. "Never touches another system" is not true of that architecture;
"processed transiently under a no-retention, no-training agreement, never
stored beyond serving the response" is the accurate claim, and it's the one
that should appear in front of users — not "100%" unqualified.

### Local mode is built, as of session 21

The paragraph below described local mode as a future tier. It is now a
configuration change: the assistant runs against anything speaking
OpenAI's `/chat/completions` shape, so pointing `ASSISTANT_BASE_URL` at a
local Ollama means **no query leaves the machine**.

Two things make this a real guarantee rather than a label:

- Whether data leaves is derived from the resolved base URL, not from the
  provider name. Pointing the "local" client at a remote host is reported
  as egress, because a LAN or hosted address is still off-machine —
  "not the public internet" is a different claim from "not off this
  machine".
- The disclosure in the UI changes with it. In local mode it says the data
  does not leave, and the third-party sentence is *not* shown. Showing a
  warning that is false in the current configuration teaches people to
  ignore the ones that are true.

What has **not** changed: this is the strongest privacy posture available
here, but the quality/latency tradeoff against a hosted frontier model is
real, and running a competitive model on your own hardware still costs
money at any scale beyond one user. Local mode being *available* is not the
same as it being the right default for a paid tier.

**The actually-100%-private option** is running an open-weight model fully
on-device or on hardware the user controls, so no query ever leaves their
own device. That's a real, stronger tier — but it trades off response
quality/latency against today's best hosted models, and it's meaningfully
more expensive to build well. Treat it as a possible future "local mode"
option once there's revenue to justify it, not a Phase 1 baseline promise —
promising it early and not delivering it is worse than not promising it.

### What session 18 actually built (2026-08-13)

The provider is **Anthropic's Claude API** (`claude-opus-5`), decided with
Omar rather than defaulted to — the deciding factor was that Anthropic's
business-API terms do not train on inputs by default, which is precisely
the contractual term the bullet above says must not be assumed.

The egress decision was **"send only what's needed, and disclose it"**, and
it is enforced in code rather than by policy. `assistant/
assistant-retrieval.ts` is the whole privacy boundary:

- The assistant never receives the mailbox. It receives at most 12
  messages, 10 events, 10 contacts, and 10 reminders, each truncated to
  1,200 characters, selected by keyword relevance to the question asked.
- Anything that function does not return cannot reach the provider. Tests
  assert the negative directly — that an unrelated message's body is *not*
  present in the outbound payload, and that one identity's data never
  appears in another's request.
- Every answer reports `contextSent` counts, so the UI can tell the user
  exactly how much of their data left the server for that question.
- `GET /identity/assistant/status` names the provider and model before the
  user asks anything, so the disclosure is available up front rather than
  buried here.

**Still true and still not claimed:** the provider processes each query
transiently. The accurate user-facing sentence remains the one above —
"processed transiently under a no-retention, no-training agreement" — not
"never leaves IDent".

**Prompt injection.** The retrieved context is other people's email, so it
is untrusted input. It is wrapped and labelled as quoted data, and the
system prompt instructs the model to report rather than obey any
instruction found inside it. This is a mitigation, not a guarantee: a
sufficiently clever injection may still influence a response. The
structural protection is that the assistant is **read-only by
construction** — there is no code path from a model response back into the
database, so even a fully successful injection cannot send, edit, or
delete anything.

### Importance filtering (session 19)

ROADMAP.md requires this filter be negotiated rather than silent, and the
implementation is shaped by that: priorities are a *separate annotation*
exposed on their own endpoint, never a filter applied to the message list —
a client that ignores the feature entirely sees every message unchanged.
Every call carries a human-readable reason; the classifier is a transparent
heuristic rather than a model call, precisely so the reason is real. A
user's stated preference (a per-contact or per-source rule) overrides the
guess, and an explicit per-message override survives re-classification.

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
