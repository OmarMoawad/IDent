import { hashPassword, verifyPassword } from "./password.js";
import { SESSION_TTL_MS, generateSessionToken, hashSessionToken } from "./session.js";
import {
  UsernameTakenError,
  createIdentity,
  findActiveSessionByTokenHash,
  findAmkWrap,
  findIdentityByUsername,
  insertSession,
  revokeSessionByTokenHash,
} from "./store.js";

export { UsernameTakenError };

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid username or password.");
    this.name = "InvalidCredentialsError";
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

function assertValidUsername(username: string): void {
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
