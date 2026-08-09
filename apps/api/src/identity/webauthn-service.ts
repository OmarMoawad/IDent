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
import { issueSession, type Session } from "./service.js";
import { findIdentityByUsername } from "./store.js";
import { CHALLENGE_TTL_MS, ORIGIN, RP_ID, RP_NAME, getPrfSaltBase64Url } from "./webauthn-config.js";
import {
  consumeChallenge,
  findCredentialByCredentialId,
  findCredentialsByIdentity,
  findPasskeyAmkWrap,
  insertChallenge,
  insertCredential,
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

export async function verifyAuthentication(
  username: string,
  response: AuthenticationResponseJSON,
): Promise<Session> {
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

  return issueSession(identity.identityId, identity.username);
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
