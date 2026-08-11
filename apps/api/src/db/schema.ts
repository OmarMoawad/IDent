import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

/**
 * Phase 1 — Communications Hub (ROADMAP.md, ARCHITECTURE.md's "Domain
 * services": communications is its own module family with its own
 * datastore, no shared tables across modules). Both tables below live in
 * this same schema.ts file for now purely as a migration-history
 * convenience (Phase 0-2 is a deliberate modular monolith per
 * ARCHITECTURE.md's current-phase note — physically one Postgres instance)
 * — the module boundary is enforced at the code layer instead:
 * comms/store.ts only ever queries these two tables plus a foreign-key
 * reference to identities.id (the one thing every domain is allowed to
 * anchor to, same as every Identity Core table), never another domain's
 * internal tables (password_credentials, webauthn_credentials, sessions,
 * etc.). Revisit physical schema-file separation if/when this module
 * needs actual separate deployment — see ARCHITECTURE.md.
 *
 * Foundation only this session (IDent_STATE.md's "Next tasks" — session
 * 13 of Phase 1): no OAuth, no external provider, no HTTP routes yet.
 * comms/store.ts is exercised directly by comms/store.test.ts against a
 * live Postgres, the same way Phase 0A's first commit proved migrations
 * work end to end before anything called it over HTTP.
 */
export const connectedSources = pgTable(
  "connected_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    // e.g. "gmail" — session 14 wired up the real Gmail connector.
    provider: text("provider").notNull(),
    status: text("status").notNull().default("pending"),
    // The provider's own stable account identifier — for Gmail this is the
    // mailbox's email address (Gmail API's users.getProfile), fetched once
    // right after token exchange (session 14.5, see gmail-service.ts's
    // completeGmailConnection). Nullable because a "pending"
    // never-completed row (or old test/seed data) has no real provider
    // account behind it yet. Without this, nothing distinguishes three
    // separate Gmail connections from three redundant connections to the
    // *same* mailbox — see the unique index below.
    providerAccountId: text("provider_account_id"),
    // Human-readable form of the same identity (for Gmail, identical to
    // providerAccountId today) — kept as its own column since a future
    // provider's stable ID and its display-friendly label won't
    // necessarily be the same string.
    providerAccountEmail: text("provider_account_email"),
    // Opaque, encrypted-at-rest ciphertext — never a plaintext token.
    encryptedTokenData: text("encrypted_token_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("connected_sources_identity_id_idx").on(table.identityId),
    // Redundant-looking unique constraint on (id, identityId), alongside
    // id's own primary key — this is what lets messages' composite foreign
    // key below reference "this source, and confirm which identity it
    // belongs to" as one constraint, not two independently-true ones. See
    // that foreign key's comment for why this needs to exist.
    unique("connected_sources_id_identity_id_key").on(table.id, table.identityId),
    // Reconnecting the same Gmail account should update the existing row,
    // never silently create a duplicate — see gmail-service.ts's
    // completeGmailConnection. NULLs (a pending/never-completed row) don't
    // collide with each other under Postgres unique-index semantics, so
    // this only actually constrains rows that reached a real provider
    // account.
    unique("connected_sources_identity_provider_account_key").on(
      table.identityId,
      table.provider,
      table.providerAccountId,
    ),
  ],
);

/**
 * The unified message/notification shape every future connector (Gmail,
 * other providers) normalizes into — one canonical object regardless of
 * source, same "unify, don't replace" principle as Receiptless's own
 * canonical Receipt object. identityId is denormalized onto this table
 * (not just reachable via sourceId -> connectedSources.identityId) so
 * every query that scopes "this identity's messages" is a single indexed
 * lookup (messages_identity_occurred_at_idx below), not a join through
 * connected_sources every time.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    // No standalone .references() here — ownership is enforced by the
    // composite foreign key below instead, which ties this column and
    // identityId together.
    sourceId: uuid("source_id").notNull(),
    // The provider's own message ID — paired with sourceId in the unique
    // index below so re-syncing the same source is idempotent (upsert on
    // conflict) instead of creating duplicate rows every sync run.
    externalId: text("external_id").notNull(),
    subject: text("subject"),
    snippet: text("snippet"),
    body: text("body"),
    // JSON-encoded array of {name, address} — no dedicated Contact table
    // yet (that's a later Phase 1 session, "Contact cards"); kept as an
    // opaque blob here rather than guessing at that table's eventual shape.
    participants: text("participants"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_source_external_id_idx").on(table.sourceId, table.externalId),
    // Matches findMessagesByIdentity's actual query shape (WHERE identityId
    // = ? ORDER BY occurredAt DESC) as one index scan, not identityId alone
    // — a composite index serves both the equality filter and the sort.
    index("messages_identity_occurred_at_idx").on(table.identityId, table.occurredAt),
    // The integrity guarantee a plain `sourceId.references(connectedSources.id)`
    // alone can't give: that this message's identityId actually matches the
    // identity that owns sourceId. Without this, comms/store.ts's
    // upsertMessage could be called (by a future bug in a sync worker, a
    // migration script, or anything else that bypasses the store's own
    // discipline) with an identityId and a sourceId belonging to two
    // different identities, and both individual foreign keys would still
    // pass — this composite one, referencing connected_sources' matching
    // (id, identity_id) unique constraint, makes that combination
    // impossible at the database level, not just enforced by convention in
    // application code.
    foreignKey({
      name: "messages_source_identity_fk",
      columns: [table.sourceId, table.identityId],
      foreignColumns: [connectedSources.id, connectedSources.identityId],
    }).onDelete("cascade"),
  ],
);

/**
 * CSRF/replay protection for a provider OAuth connection flow (session 14
 * — comms/gmail-service.ts). Unlike identity/webauthn's challenges (looked
 * up by identityId + purpose, since the caller already knows who it's
 * talking to from an authenticated session), the OAuth callback is an
 * anonymous top-level browser redirect from the provider — no bearer
 * token, no session. `state` is the *only* thing correlating that request
 * back to the identity and provider that started the flow, so it's the
 * lookup key here (hence its own unique index), not identityId. Same
 * single-use/short-lived shape as webauthn_challenges otherwise:
 * consumedAt is set the moment it's checked, pass or fail, so a state
 * value can never be replayed even after a failed callback.
 */
export const oauthStateChallenges = pgTable(
  "oauth_state_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    state: text("state").notNull(),
    // PKCE (session 14.5): the random verifier this same request's
    // authorization URL committed to via a SHA-256 code_challenge —
    // consumed alongside state at code-exchange time and sent to Google
    // as code_verifier, so a stolen authorization code is useless without
    // it too. Standard hardening for a public redirect step even though
    // this is a confidential (client-secret-holding) client — see
    // gmail-service.ts's startGmailConnection/completeGmailConnection.
    pkceVerifier: text("pkce_verifier").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("oauth_state_challenges_state_idx").on(table.state)],
);
