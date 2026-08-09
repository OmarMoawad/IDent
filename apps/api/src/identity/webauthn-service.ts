import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { issueSession, type Session } from "./service.js";
import { findIdentityByUsername, upsertAmkWrap } from "./store.js";
import { CHALLENGE_TTL_MS, ORIGIN, RP_ID, RP_NAME } from "./webauthn-config.js";
import {
  consumeChallenge,
  findCredentialByCredentialId,
  findCredentialsByIdentity,
  insertChallenge,
  insertCredential,
  updateCredentialCounter,
} from "./webauthn-store.js";

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
 * `wrappedAmkKey` is the same opaque-blob-from-the-caller convention as
 * password registration (see IDent_STATE.md) — "passkey" is a distinct
 * factor in the AMK key hierarchy (ARCHITECTURE.md), but nothing generates
 * a real client-side wrap for it yet (that needs the PRF/largeBlob
 * extension, deliberately deferred — see "Next tasks").
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
  await insertCredential({
    identityId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: encodeTransports(credential.transports),
  });

  await upsertAmkWrap({ identityId, factor: "passkey", wrappedKey: wrappedAmkKey });
}

export async function getAuthenticationOptions(username: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const identity = await findIdentityByUsername(username);
  if (!identity) throw new UnknownUsernameError();

  const credentials = await findCredentialsByIdentity(identity.identityId);
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: decodeTransports(credential.transports),
    })),
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
