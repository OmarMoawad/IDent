import { pgTable, primaryKey, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
 * leaked factor rewraps that row without touching the others.
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
  },
  (table) => [uniqueIndex("sessions_token_hash_idx").on(table.tokenHash)],
);
