import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationExtensionsClientInputs,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { hashPassword } from "./password.js";
import { generateRecoveryCode as generateRecoveryCodeValue, normalizeRecoveryCode } from "./recovery-code.js";
import {
  ElevationVerificationError,
  type AuthenticatedIdentity,
  assertValidUsername,
  issueSession,
  type Session,
} from "./service.js";
import { ELEVATION_TTL_MS } from "./session.js";
import { elevateSessionById, findIdentityByUsername } from "./store.js";
import { CHALLENGE_TTL_MS, ORIGIN, RP_ID, RP_NAME, getPrfSaltBase64Url } from "./webauthn-config.js";
import {
  consumeChallenge,
  consumePasswordlessRegistrationChallenge,
  createIdentityWithPasskey,
  findCredentialByCredentialId,
  findCredentialsByIdentity,
  findPasskeyAmkWrap,
  insertChallenge,
  insertCredential,
  insertPasswordlessRegistrationChallenge,
  updateCredentialCounter,
  upsertPasskeyAmkWrap,
} from "./webauthn-store.js";

/**
 * @simplewebauthn/server's bundled DOM type shim (AuthenticationExtensions-
 * ClientInputs) predates the WebAuthn PRF extension — this cast reaches
 * past that typing gap to the real, browser-supported `prf` extension
 * fields (https://w3c.github.io/webauthn/#prf-extension), not a custom
 * extension of our own. See apps/web/lib/prf.ts for the matching client
 * side.
 */
function withPrfExtension(extensions: { prf: { eval?: { first: string } } }): AuthenticationExtensionsClientInputs {
  return extensions as unknown as AuthenticationExtensionsClientInputs;
}

export class UnknownUsernameError extends Error {
  constructor() {
    super("No account with that username.");
    this.name = "UnknownUsernameError";
  }
}

export class ChallengeExpiredError extends Error {
  constructor() {
    super("The registration or login attempt expired or was already used. Start again.");
    this.name = "ChallengeExpiredError";
  }
}

export class WebauthnVerificationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WebauthnVerificationError";
  }
}

export class UnknownCredentialError extends Error {
  constructor() {
    super("This passkey is not registered to this account.");
    this.name = "UnknownCredentialError";
  }
}

function encodeTransports(transports: readonly AuthenticatorTransportFuture[] | undefined): string | null {
  return transports && transports.length > 0 ? JSON.stringify(transports) : null;
}

function decodeTransports(encoded: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!encoded) return undefined;
  return JSON.parse(encoded) as AuthenticatorTransportFuture[];
}

export async function getRegistrationOptions(
  identityId: string,
  username: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await findCredentialsByIdentity(identityId);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    userID: new TextEncoder().encode(identityId),
    attestationType: "none",
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: decodeTransports(credential.transports),
    })),
    // Empty eval: this create() call only asks the browser to report PRF
    // *support* (clientExtensionResults.prf.enabled). The actual secret
    // is pulled by a follow-up get() right after — see apps/web/lib/prf.ts
    // for why create()-time PRF results aren't relied on directly.
    extensions: withPrfExtension({ prf: {} }),
  });

  await insertChallenge({
    identityId,
    purpose: "registration",
    challenge: options.challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return options;
}

/**
 * `wrappedAmkKey` is an opaque blob from the caller, same convention as
 * password registration (see IDent_STATE.md) — the server never interprets
 * it. apps/web now produces a real PRF-derived wrap when the authenticator
 * supports it; when it doesn't (or the AMK wasn't loaded at registration
 * time), the client sends an honest placeholder instead of fabricating
 * ciphertext nothing can unwrap later. Stored per-credential (not per
 * factor) in passkey_amk_wraps — see that table's comment in schema.ts for
 * why.
 */
export async function verifyRegistration(
  identityId: string,
  response: RegistrationResponseJSON,
  wrappedAmkKey: string,
): Promise<void> {
  const expectedChallenge = await consumeChallenge(identityId, "registration");
  if (!expectedChallenge) throw new ChallengeExpiredError();

  // `response` is attacker-controlled JSON off the wire — the library can
  // throw on malformed input (bad base64url, missing fields) rather than
  // cleanly returning `verified: false`. Treat any such throw the same as
  // a failed verification, not an unhandled 500.
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  }).catch(() => ({ verified: false as const }));

  if (!verification.verified || !verification.registrationInfo) {
    throw new WebauthnVerificationError("Passkey registration could not be verified.");
  }

  const { credential } = verification.registrationInfo;
  const inserted = await insertCredential({
    identityId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: encodeTransports(credential.transports),
  });

  await upsertPasskeyAmkWrap({ credentialId: inserted.id, identityId, wrappedKey: wrappedAmkKey });
}

/**
 * Passwordless-registration counterpart to getRegistrationOptions: no
 * identity exists yet, so there's no identityId to key the challenge or
 * excludeCredentials by (a brand-new identity can't already have any
 * credentials to exclude). See passwordlessRegistrationChallenges' comment
 * in schema.ts for why this needs its own username-keyed challenge table
 * rather than reusing webauthn_challenges.
 */
export async function getPasswordlessRegistrationOptions(
  username: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  assertValidUsername(username);

  // An opaque random handle, not the username itself — WebAuthn's userID is
  // meant to avoid carrying PII (some authenticators persist it), and since
  // no identity row exists yet there's no identity_id to reuse the way
  // getRegistrationOptions above does. Nothing needs to read this handle
  // back later: the real, permanent identity_id is minted separately by
  // createIdentityWithPasskey once verification succeeds.
  const userHandle = randomUUID();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    userID: new TextEncoder().encode(userHandle),
    attestationType: "none",
    excludeCredentials: [],
    extensions: withPrfExtension({ prf: {} }),
  });

  await insertPasswordlessRegistrationChallenge({
    username,
    challenge: options.challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return options;
}

/**
 * Verifies a passwordless registration ceremony and creates the identity —
 * the username is only actually claimed here, inside
 * createIdentityWithPasskey's transaction, once the passkey itself has
 * verified (see that function's comment for why, and why it also mints a
 * mandatory recovery credential). Returns the recovery code's plaintext
 * alongside the new session — the caller (apps/web) still has to wrap the
 * AMK with it and PUT it to /identity/recovery/wrap, same two-step
 * exchange as the authenticated recovery-code-generation flow, since the
 * server can't wrap anything with a secret only the client holds.
 */
export async function verifyPasswordlessRegistration(
  username: string,
  response: RegistrationResponseJSON,
  wrappedAmkKey: string,
): Promise<Session & { recoveryCode: string }> {
  assertValidUsername(username);

  const expectedChallenge = await consumePasswordlessRegistrationChallenge(username);
  if (!expectedChallenge) throw new ChallengeExpiredError();

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  }).catch(() => ({ verified: false as const }));

  if (!verification.verified || !verification.registrationInfo) {
    throw new WebauthnVerificationError("Passkey registration could not be verified.");
  }

  const { credential } = verification.registrationInfo;
  const recoveryCode = generateRecoveryCodeValue();
  const recoveryCodeHash = await hashPassword(normalizeRecoveryCode(recoveryCode));

  const { identityId } = await createIdentityWithPasskey({
    username,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: encodeTransports(credential.transports),
    wrappedAmkKey,
    recoveryCodeHash,
  });

  const session = await issueSession(identityId, username);
  return { ...session, recoveryCode };
}

export async function getAuthenticationOptions(username: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const identity = await findIdentityByUsername(username);
  if (!identity) throw new UnknownUsernameError();

  const credentials = await findCredentialsByIdentity(identity.identityId);
  const prfSalt = await getPrfSaltBase64Url();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: decodeTransports(credential.transports),
    })),
    // Evaluates PRF in the same get() ceremony as the real login signature
    // — one user gesture produces both a verified assertion and the secret
    // apps/web needs to unwrap this credential's AMK wrap, if it has one.
    extensions: withPrfExtension({ prf: { eval: { first: prfSalt } } }),
  });

  await insertChallenge({
    identityId: identity.identityId,
    purpose: "authentication",
    challenge: options.challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return options;
}

/**
 * The core of a passkey authentication ceremony — verify the signed
 * assertion against the challenge this server issued and the stored
 * public key, then advance the counter. Shared by login (verifyAuthentication,
 * which turns a successful result into a brand-new session) and step-up
 * (elevateWithPasskeyAssertion, which turns one into an elevation of the
 * *existing* session instead) so there's exactly one place that verifies a
 * passkey assertion, not two copies drifting apart.
 */
async function verifyAssertion(
  username: string,
  response: AuthenticationResponseJSON,
): Promise<{ identityId: string; username: string }> {
  const identity = await findIdentityByUsername(username);
  if (!identity) throw new UnknownUsernameError();

  const expectedChallenge = await consumeChallenge(identity.identityId, "authentication");
  if (!expectedChallenge) throw new ChallengeExpiredError();

  const stored = await findCredentialByCredentialId(response.id);
  if (!stored || stored.identityId !== identity.identityId) {
    throw new UnknownCredentialError();
  }

  // Same reasoning as verifyRegistration above: don't let malformed
  // attacker-controlled input surface as an unhandled 500.
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: stored.credentialId,
      publicKey: Buffer.from(stored.publicKey, "base64url"),
      counter: stored.counter,
    },
  }).catch(() => null);

  if (!verification?.verified) {
    throw new WebauthnVerificationError("Passkey authentication could not be verified.");
  }

  await updateCredentialCounter(stored.id, verification.authenticationInfo.newCounter);

  return { identityId: identity.identityId, username: identity.username };
}

export async function verifyAuthentication(
  username: string,
  response: AuthenticationResponseJSON,
): Promise<Session> {
  const identity = await verifyAssertion(username, response);
  return issueSession(identity.identityId, identity.username);
}

/**
 * Step-up counterpart to verifyAuthentication: re-verifies a passkey
 * assertion the same way a passkey login does (verifyAssertion above), but
 * elevates the caller's *existing* session instead of issuing a new one.
 * Always asserts against `identity.username` — the already-authenticated
 * identity from the caller's bearer session, never a username the client
 * could supply separately — so this can only ever elevate with that same
 * identity's own passkey, not borrow a different account's credential.
 * Every failure mode (unknown username — unreachable in practice since
 * identity.username is already a real, logged-in identity;
 * expired/replayed challenge; wrong credential; bad signature) collapses to
 * ElevationVerificationError, the same "step-up denied" outcome
 * elevation-routes.ts already handles for the password/recovery factors.
 */
export async function elevateWithPasskeyAssertion(
  identity: Pick<AuthenticatedIdentity, "sessionId" | "username">,
  response: AuthenticationResponseJSON,
): Promise<Date> {
  await verifyAssertion(identity.username, response).catch(() => {
    throw new ElevationVerificationError();
  });

  const elevatedUntil = new Date(Date.now() + ELEVATION_TTL_MS);
  await elevateSessionById(identity.sessionId, elevatedUntil);
  return elevatedUntil;
}

/**
 * Fetches the AMK wrap for one specific passkey credential — not "the
 * passkey factor" in general, since each credential has its own wrap (see
 * passkey_amk_wraps' comment in schema.ts). Ownership is re-checked here
 * (not just "does this credential exist") so one identity's session can
 * never read another identity's wrap by guessing/observing a credentialId.
 */
export async function getPasskeyAmkWrap(identityId: string, credentialId: string): Promise<string | null> {
  const stored = await findCredentialByCredentialId(credentialId);
  if (!stored || stored.identityId !== identityId) return null;
  return findPasskeyAmkWrap(stored.id);
}
