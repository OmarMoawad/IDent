import { hashPassword, verifyPassword } from "./password.js";
import { generateRecoveryCode as generateRecoveryCodeValue, normalizeRecoveryCode } from "./recovery-code.js";
import { SESSION_TTL_MS, generateSessionToken, hashSessionToken } from "./session.js";
import {
  UsernameTakenError,
  createIdentity,
  findActiveSessionByTokenHash,
  findAmkWrap,
  findIdentityByUsername,
  findRecoveryCredentialByUsername,
  insertSession,
  revokeSessionByTokenHash,
  upsertAmkWrap,
  upsertRecoveryCredential,
} from "./store.js";

export { UsernameTakenError };

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid username or password.");
    this.name = "InvalidCredentialsError";
  }
}

export class InvalidRecoveryCodeError extends Error {
  constructor() {
    super("Invalid username or recovery code.");
    this.name = "InvalidRecoveryCodeError";
  }
}

export class InvalidUsernameError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidUsernameError";
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super("Password must be at least 8 characters.");
    this.name = "WeakPasswordError";
  }
}

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

export function assertValidUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvalidUsernameError(
      "Username must be 3-32 characters, start with a lowercase letter, and contain only lowercase letters, digits, and underscores.",
    );
  }
}

function assertValidPassword(password: string): void {
  if (password.length < 8) throw new WeakPasswordError();
}

// Verified against on a username that doesn't exist, so "no such user" and
// "wrong password" cost the same wall-clock time and can't be told apart by
// an attacker probing for valid usernames. Computed once, lazily, not at
// module load, so importing this module never pays a scrypt hash for free.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("timing-safety-placeholder-never-a-real-password");
  return dummyHash;
}

// Same timing-safety trick as getDummyHash, kept as its own cached value
// (not shared with the password one) so the two factors stay independently
// reasoned-about even though the underlying scrypt call is identical.
let dummyRecoveryHash: Promise<string> | undefined;
function getDummyRecoveryHash(): Promise<string> {
  if (!dummyRecoveryHash) {
    dummyRecoveryHash = hashPassword("timing-safety-placeholder-never-a-real-recovery-code");
  }
  return dummyRecoveryHash;
}

export type Session = {
  identityId: string;
  username: string;
  sessionToken: string;
  expiresAt: Date;
};

export async function issueSession(identityId: string, username: string): Promise<Session> {
  const sessionToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession({ identityId, tokenHash: hashSessionToken(sessionToken), expiresAt });
  return { identityId, username, sessionToken, expiresAt };
}

export async function register(input: {
  username: string;
  password: string;
  wrappedAmkKey: string;
}): Promise<Session> {
  assertValidUsername(input.username);
  assertValidPassword(input.password);

  const passwordHash = await hashPassword(input.password);
  const { identityId } = await createIdentity({
    username: input.username,
    passwordHash,
    wrappedAmkKey: input.wrappedAmkKey,
  });
  return issueSession(identityId, input.username);
}

export async function loginWithPassword(input: { username: string; password: string }): Promise<Session> {
  const record = await findIdentityByUsername(input.username);
  const passwordHash = record?.passwordHash ?? (await getDummyHash());
  const valid = await verifyPassword(input.password, passwordHash);

  if (!record || !valid) throw new InvalidCredentialsError();
  return issueSession(record.identityId, record.username);
}

export type AuthenticatedIdentity = {
  sessionId: string;
  identityId: string;
  username: string;
};

/**
 * The reusable check other domain services import directly (modular
 * monolith, per ARCHITECTURE.md's current-phase note) — not an HTTP call to
 * this same process. Once a module is split out as its own deployment, this
 * becomes that module's client for an Identity Core validation endpoint.
 */
export async function validateSession(sessionToken: string): Promise<AuthenticatedIdentity | null> {
  return findActiveSessionByTokenHash(hashSessionToken(sessionToken));
}

export async function logout(sessionToken: string): Promise<void> {
  await revokeSessionByTokenHash(hashSessionToken(sessionToken));
}

/**
 * Lets an already-authenticated client fetch its own wrapped AMK for a
 * given factor back out (e.g. after logging in with a password on a new
 * device, to unwrap the AMK locally) — never decrypted server-side, the
 * server is just handing back the opaque blob it was given at registration.
 */
export async function getAmkWrap(identityId: string, factor: string): Promise<string | null> {
  return findAmkWrap(identityId, factor);
}

/**
 * Generates a fresh recovery code, stores its hash (replacing any previous
 * code — see recovery_credentials' comment in schema.ts), and returns the
 * plaintext code exactly once. The caller is responsible for showing it to
 * the user and then wrapping the AMK with it via setRecoveryAmkWrap — the
 * server never learns the AMK either way, same as the password factor.
 */
export async function generateRecoveryCode(identityId: string): Promise<string> {
  const code = generateRecoveryCodeValue();
  const codeHash = await hashPassword(normalizeRecoveryCode(code));
  await upsertRecoveryCredential(identityId, codeHash);
  return code;
}

/**
 * Stores the client-computed AMK wrap for the "recovery" factor, reusing
 * account_master_key_wraps (see its comment in schema.ts for why recovery
 * doesn't need its own wrap table the way passkeys do). Opaque passthrough,
 * same convention as every other factor's wrap.
 */
export async function setRecoveryAmkWrap(identityId: string, wrappedAmkKey: string): Promise<void> {
  await upsertAmkWrap({ identityId, factor: "recovery", wrappedKey: wrappedAmkKey });
}

export async function loginWithRecoveryCode(input: { username: string; recoveryCode: string }): Promise<Session> {
  const record = await findRecoveryCredentialByUsername(input.username);
  const codeHash = record?.codeHash ?? (await getDummyRecoveryHash());
  const valid = await verifyPassword(normalizeRecoveryCode(input.recoveryCode), codeHash);

  if (!record || !valid) throw new InvalidRecoveryCodeError();
  return issueSession(record.identityId, record.username);
}
