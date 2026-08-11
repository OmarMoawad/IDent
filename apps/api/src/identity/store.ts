import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  accountMasterKeyWraps,
  identities,
  passwordCredentials,
  recoveryCredentials,
  sessions,
  usernameAliases,
} from "../db/schema.js";

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already taken.`);
    this.name = "UsernameTakenError";
  }
}

export function isUniqueViolation(err: unknown): boolean {
  // drizzle wraps the raw pg error (which carries the SQLSTATE `code`) in a
  // DrizzleQueryError and exposes the original as `.cause` — the code isn't
  // on the wrapper itself.
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

export type NewIdentity = {
  username: string;
  passwordHash: string;
  wrappedAmkKey: string;
};

export async function createIdentity(input: NewIdentity): Promise<{ identityId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [identity] = await tx.insert(identities).values({}).returning({ id: identities.id });
      await tx.insert(usernameAliases).values({ identityId: identity.id, username: input.username });
      await tx.insert(passwordCredentials).values({
        identityId: identity.id,
        passwordHash: input.passwordHash,
      });
      // "password" is the only factor Phase 0B can produce — a wrap row per
      // additional factor (passkey, device, recovery) joins later without
      // touching this one, per ARCHITECTURE.md's key-hierarchy note.
      await tx.insert(accountMasterKeyWraps).values({
        identityId: identity.id,
        factor: "password",
        wrappedKey: input.wrappedAmkKey,
      });
      return { identityId: identity.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new UsernameTakenError(input.username);
    throw err;
  }
}

export type IdentityByUsername = {
  identityId: string;
  username: string;
  passwordHash: string | null;
};

/**
 * Used for both password login (service.ts's loginWithPassword) and to
 * resolve a username before a passkey login ceremony (webauthn-service.ts's
 * getAuthenticationOptions/verifyAuthentication) — those two callers need
 * identityId/username, not passwordHash. This must be a LEFT JOIN on
 * password_credentials, not an inner join: a passwordless identity (see
 * webauthn-store.ts's createIdentityWithPasskey) has no row there at all,
 * and an inner join would silently exclude it from every lookup —
 * including passkey login, which is that identity's *only* way to log in.
 * (Found via manual browser testing: passkey login for a
 * passwordless-registered identity failed with "no account with that
 * username" even though the identity, username, and credential all
 * existed — vitest never caught it because every existing passkey-login
 * test registers a password identity first.)
 */
export async function findIdentityByUsername(username: string): Promise<IdentityByUsername | null> {
  const rows = await db
    .select({
      identityId: identities.id,
      username: usernameAliases.username,
      passwordHash: passwordCredentials.passwordHash,
    })
    .from(usernameAliases)
    .innerJoin(identities, eq(identities.id, usernameAliases.identityId))
    .leftJoin(passwordCredentials, eq(passwordCredentials.identityId, identities.id))
    .where(eq(usernameAliases.username, username))
    .limit(1);
  return rows[0] ?? null;
}

export type AmkWrap = {
  identityId: string;
  factor: string;
  wrappedKey: string;
};

/**
 * Adds or replaces the wrap for one (identity, factor) pair — used when a
 * factor is registered for the first time, or re-registered after removal
 * (e.g. a replaced passkey), never to touch another factor's row.
 */
export async function upsertAmkWrap(input: AmkWrap): Promise<void> {
  await db
    .insert(accountMasterKeyWraps)
    .values(input)
    .onConflictDoUpdate({
      target: [accountMasterKeyWraps.identityId, accountMasterKeyWraps.factor],
      set: { wrappedKey: input.wrappedKey, updatedAt: new Date() },
    });
}

export async function findAmkWrap(identityId: string, factor: string): Promise<string | null> {
  const rows = await db
    .select({ wrappedKey: accountMasterKeyWraps.wrappedKey })
    .from(accountMasterKeyWraps)
    .where(and(eq(accountMasterKeyWraps.identityId, identityId), eq(accountMasterKeyWraps.factor, factor)))
    .limit(1);
  return rows[0]?.wrappedKey ?? null;
}

export type IdentityByUsernameForRecovery = {
  identityId: string;
  username: string;
  codeHash: string;
};

/**
 * Mirrors findIdentityByUsername but joins recovery_credentials instead of
 * password_credentials — returns null both for an unknown username and for
 * a real identity that has never generated a recovery code, since the
 * caller (loginWithRecoveryCode) treats both the same way for timing safety.
 */
export async function findRecoveryCredentialByUsername(
  username: string,
): Promise<IdentityByUsernameForRecovery | null> {
  const rows = await db
    .select({
      identityId: identities.id,
      username: usernameAliases.username,
      codeHash: recoveryCredentials.codeHash,
    })
    .from(usernameAliases)
    .innerJoin(identities, eq(identities.id, usernameAliases.identityId))
    .innerJoin(recoveryCredentials, eq(recoveryCredentials.identityId, identities.id))
    .where(eq(usernameAliases.username, username))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Replaces the identity's recovery code hash — one row per identity, so
 * regenerating invalidates the previous code immediately rather than
 * leaving multiple valid codes outstanding.
 */
export async function upsertRecoveryCredential(identityId: string, codeHash: string): Promise<void> {
  await db
    .insert(recoveryCredentials)
    .values({ identityId, codeHash })
    .onConflictDoUpdate({
      target: recoveryCredentials.identityId,
      set: { codeHash, updatedAt: new Date() },
    });
}

export async function insertSession(input: {
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(sessions).values(input);
}

export type ActiveSession = {
  sessionId: string;
  identityId: string;
  username: string;
  elevatedUntil: Date | null;
};

export async function findActiveSessionByTokenHash(tokenHash: string): Promise<ActiveSession | null> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      identityId: sessions.identityId,
      username: usernameAliases.username,
      elevatedUntil: sessions.elevatedUntil,
    })
    .from(sessions)
    .innerJoin(usernameAliases, eq(usernameAliases.identityId, sessions.identityId))
    .where(
      and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeSessionByTokenHash(tokenHash: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}

/**
 * Elevates an existing base session in place (SECURITY.md's tiering) — same
 * session row (id/identityId/createdAt unchanged), never a second
 * session/token — but rotates the bearer token's hash in the same update.
 * Without this, elevation would be a pure attribute of the session row: if a
 * base session's bearer token had already been stolen (session hijack, the
 * base session's own long-standing risk), the *attacker's* copy of that
 * token would silently start passing requireElevatedSession the moment the
 * legitimate owner elevated the same session — no new re-authentication by
 * the attacker required. Rotating the token here means the old raw token
 * stops matching any row's tokenHash the instant elevation succeeds, so a
 * stolen pre-elevation copy is dead, not quietly upgraded (OWASP session
 * management guidance: regenerate the session identifier on any privilege
 * change). The caller is responsible for handing the new raw token back to
 * the legitimate client — see identity/service.ts and
 * identity/webauthn-service.ts's elevate* functions. Guarded by the same
 * revoked/expired check as findActiveSessionByTokenHash so a dead base
 * session can't be elevated back into validity by racing a factor
 * re-verification against its own expiry/logout.
 */
export async function elevateSessionById(
  sessionId: string,
  elevatedUntil: Date,
  newTokenHash: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ elevatedUntil, tokenHash: newTokenHash })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
}
