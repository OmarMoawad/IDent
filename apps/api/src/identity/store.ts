import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  accountMasterKeyWraps,
  identities,
  passwordCredentials,
  sessions,
  usernameAliases,
} from "../db/schema.js";

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already taken.`);
    this.name = "UsernameTakenError";
  }
}

function isUniqueViolation(err: unknown): boolean {
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
  passwordHash: string;
};

export async function findIdentityByUsername(username: string): Promise<IdentityByUsername | null> {
  const rows = await db
    .select({
      identityId: identities.id,
      username: usernameAliases.username,
      passwordHash: passwordCredentials.passwordHash,
    })
    .from(usernameAliases)
    .innerJoin(identities, eq(identities.id, usernameAliases.identityId))
    .innerJoin(passwordCredentials, eq(passwordCredentials.identityId, identities.id))
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
};

export async function findActiveSessionByTokenHash(tokenHash: string): Promise<ActiveSession | null> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      identityId: sessions.identityId,
      username: usernameAliases.username,
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
