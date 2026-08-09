import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { webauthnChallenges, webauthnCredentials } from "../db/schema.js";

export type NewChallenge = {
  identityId: string;
  purpose: string;
  challenge: string;
  expiresAt: Date;
};

export async function insertChallenge(input: NewChallenge): Promise<void> {
  await db.insert(webauthnChallenges).values(input);
}

/**
 * Atomically fetches and consumes the most recent unexpired, unconsumed
 * challenge for (identity, purpose), or returns null if none exists.
 * "Atomic" here means: under concurrent calls, at most one can win the
 * UPDATE — Postgres re-checks `consumed_at IS NULL` against the committed
 * row once a lock releases, so a second racer's UPDATE affects zero rows
 * and gets null back, rather than both callers successfully consuming the
 * same challenge.
 */
export async function consumeChallenge(identityId: string, purpose: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: webauthnChallenges.id, challenge: webauthnChallenges.challenge })
      .from(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.identityId, identityId),
          eq(webauthnChallenges.purpose, purpose),
          isNull(webauthnChallenges.consumedAt),
          gt(webauthnChallenges.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(webauthnChallenges.createdAt))
      .limit(1);

    const pending = rows[0];
    if (!pending) return null;

    const updated = await tx
      .update(webauthnChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(webauthnChallenges.id, pending.id), isNull(webauthnChallenges.consumedAt)))
      .returning({ challenge: webauthnChallenges.challenge });

    return updated[0]?.challenge ?? null;
  });
}

export type NewCredential = {
  identityId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
};

export async function insertCredential(input: NewCredential): Promise<void> {
  await db.insert(webauthnCredentials).values(input);
}

export type CredentialSummary = {
  credentialId: string;
  transports: string | null;
};

export async function findCredentialsByIdentity(identityId: string): Promise<CredentialSummary[]> {
  return db
    .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.identityId, identityId));
}

export type StoredCredential = {
  id: string;
  identityId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
};

export async function findCredentialByCredentialId(credentialId: string): Promise<StoredCredential | null> {
  const rows = await db
    .select({
      id: webauthnCredentials.id,
      identityId: webauthnCredentials.identityId,
      credentialId: webauthnCredentials.credentialId,
      publicKey: webauthnCredentials.publicKey,
      counter: webauthnCredentials.counter,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialId, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateCredentialCounter(id: string, counter: number): Promise<void> {
  await db.update(webauthnCredentials).set({ counter, lastUsedAt: new Date() }).where(eq(webauthnCredentials.id, id));
}
