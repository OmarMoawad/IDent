import { integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Phase 0A infra-proving table only — confirms migrations run end to end.
 */
export const systemHealthChecks = pgTable("system_health_checks", {
  id: serial("id").primaryKey(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Phase 0B — Identity Core (ARCHITECTURE.md "Data model note" / "Identity Core").
 * identities.id is the immutable identity_id every other table/module references.
 * It is never a username, email, or phone number.
 */
export const identities = pgTable("identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The public @username: unique, mutable, resolves to identity_id. One row per
 * identity — renaming updates this row in place, never a new primary key.
 */
export const usernameAliases = pgTable(
  "username_aliases",
  {
    identityId: uuid("identity_id")
      .primaryKey()
      .references(() => identities.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("username_aliases_username_idx").on(table.username)],
);

export const passwordCredentials = pgTable("password_credentials", {
  identityId: uuid("identity_id")
    .primaryKey()
    .references(() => identities.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Client-generated Account Master Key, wrapped per-factor (ARCHITECTURE.md
 * "Identity Core" key hierarchy). wrappedKey is opaque ciphertext the server
 * never unwraps or interprets — only the client that holds the matching
 * factor secret can unwrap it. One row per (identity, factor) so rotating a
 * leaked factor rewraps that row without touching the others. In practice
 * this only ever holds the "password" factor: passkeys don't fit the
 * one-secret-per-factor assumption (each credential has its own PRF
 * secret), so they live in passkey_amk_wraps instead — see that table's
 * comment below.
 */
export const accountMasterKeyWraps = pgTable(
  "account_master_key_wraps",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    factor: text("factor").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.identityId, table.factor] })],
);

/**
 * A regenerable server-generated recovery code, hashed the same way as a
 * password (see identity/password.ts — its scrypt implementation is generic,
 * not password-specific). This is the "its own wrapped copy, its own
 * factor" recovery path ARCHITECTURE.md's key-hierarchy note calls for: the
 * code itself unlocks a session (like a password) and the matching
 * account_master_key_wraps row with factor "recovery" (reusing that table,
 * not a new one, because a recovery code is one interchangeable secret per
 * identity, same as password). One row per identity — regenerating replaces
 * it in place, invalidating the old code immediately.
 */
export const recoveryCredentials = pgTable("recovery_credentials", {
  identityId: uuid("identity_id")
    .primaryKey()
    .references(() => identities.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Short-lived session tokens. Only the sha256 hash of the bearer token is
 * stored — the raw token is returned to the client once, at issuance, and
 * cannot be recovered from this table.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Step-up state layered on top of this same base session (SECURITY.md's
    // tiering) — not a second session/token. Null means "not elevated". Set
    // by re-entering an existing factor (identity/elevation-routes.ts) and
    // checked fresh against now() on every High/Critical-tier request
    // (identity/elevation.ts's requireElevatedSession) — never trusted from
    // a client-supplied claim.
    elevatedUntil: timestamp("elevated_until", { withTimezone: true }),
  },
  (table) => [uniqueIndex("sessions_token_hash_idx").on(table.tokenHash)],
);

/**
 * A registered WebAuthn authenticator, one row per credential (an identity
 * can register more than one — phone + hardware key, say). credentialId is
 * the authenticator-chosen identifier (base64url); publicKey is the COSE
 * public key bytes (base64url) used to verify future assertion signatures.
 * counter is the authenticator's signature counter, used to detect cloned
 * authenticators (per WebAuthn spec: it must strictly increase).
 */
export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("webauthn_credentials_credential_id_idx").on(table.credentialId)],
);

/**
 * Passkey-specific AMK wraps — one row per WebAuthn credential, not per
 * (identity, factor) like account_master_key_wraps. Each passkey's PRF
 * output is unique to that authenticator, so a wrap made with one
 * passkey's PRF secret can't be opened by a different passkey belonging
 * to the same identity; account_master_key_wraps' one-row-per-factor
 * shape assumes a factor produces one interchangeable secret, which is
 * true for password but not for multiple independent passkeys.
 */
export const passkeyAmkWraps = pgTable("passkey_amk_wraps", {
  credentialId: uuid("credential_id")
    .primaryKey()
    .references(() => webauthnCredentials.id, { onDelete: "cascade" }),
  identityId: uuid("identity_id")
    .notNull()
    .references(() => identities.id, { onDelete: "cascade" }),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The passwordless-registration equivalent of webauthn_challenges below,
 * kept as a separate table because it's keyed by username instead of
 * identity_id — passwordless registration's whole point is that no
 * identity row exists yet when the ceremony starts (see webauthn-service.ts
 * getPasswordlessRegistrationOptions/verifyPasswordlessRegistration). The
 * username is only actually claimed inside the same DB transaction that
 * verifies the passkey and creates the identity, not here, so an abandoned
 * ceremony never squats a username.
 */
export const passwordlessRegistrationChallenges = pgTable("passwordless_registration_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull(),
  challenge: text("challenge").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

/**
 * A pending registration or authentication ceremony's server-generated
 * challenge, so the verify step can confirm the signed response answers the
 * exact challenge this server issued (replay/substitution protection).
 * Short-lived and single-use — consumedAt is set the moment it's checked,
 * pass or fail, so a challenge can never be replayed even after a failed
 * verify.
 */
export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityId: uuid("identity_id")
    .notNull()
    .references(() => identities.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  challenge: text("challenge").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
