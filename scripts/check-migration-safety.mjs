#!/usr/bin/env node
/**
 * Session 22c — enforce the property IDent's rollback procedure depends
 * on (external review item 4, migration releases).
 *
 * DEPLOYMENT.md says rolling back is safe *because* migrations are
 * additive: redeploying an older build does not roll back a migration, so
 * the previous release's code must still run against the current schema.
 * That is the entire basis for "redeploy the last good build" being a
 * recovery procedure rather than a second outage.
 *
 * Nothing enforced it. A rule written in a document and hoped for is the
 * same class of unverified claim this session exists to remove — so it is
 * checked here, at PR time, when fixing it is cheap.
 *
 * Ported from Receiptless's script of the same name; the rules are
 * identical because the property is. The difference is that drizzle emits
 * flat `.sql` files rather than a directory per migration.
 *
 * Usage:
 *   node scripts/check-migration-safety.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/api/src/db/migrations");

/**
 * Statements that break code compiled against the *previous* schema.
 *
 * `ADD COLUMN ... NOT NULL` without a default is included deliberately:
 * the new column is invisible to old code, so every insert the old
 * release performs omits it and fails. With a default it is fine, which
 * is why the pattern checks for the absence of one.
 */
const DESTRUCTIVE_PATTERNS = [
  { name: "DROP COLUMN", pattern: /ALTER\s+TABLE[\s\S]{0,200}?DROP\s+COLUMN/i },
  { name: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { name: "RENAME COLUMN", pattern: /\bRENAME\s+COLUMN\b/i },
  { name: "RENAME TO (table)", pattern: /ALTER\s+TABLE[\s\S]{0,200}?\bRENAME\s+TO\b/i },
  { name: "SET NOT NULL on an existing column", pattern: /ALTER\s+COLUMN[\s\S]{0,80}?SET\s+NOT\s+NULL/i },
  {
    name: "ADD COLUMN NOT NULL without DEFAULT",
    pattern: /ADD\s+COLUMN\s+"?[\w]+"?\s+[\w()]+\s+NOT\s+NULL(?![\s\S]{0,40}?DEFAULT)/i,
  },
  { name: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
  { name: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
];

/**
 * Migrations that are destructive but already applied and understood.
 *
 * An allowlist rather than "ignore anything older than today", because
 * the point is that each exception was looked at once and reasoned about.
 * A new entry should be an argued decision, not a way to silence the
 * check.
 */
const ALLOWLIST = new Map([
  [
    "0010_jazzy_violations.sql",
    "Session 14. Adds oauth_state_challenges.pkce_verifier as NOT NULL " +
      "with no default, which would break inserts from a release that " +
      "does not know the column. Safe only because IDent has never been " +
      "deployed: there is no released build to roll back to. If it had " +
      "been, the fix is the standard two-release split — add nullable, " +
      "backfill, tighten in the next release.",
  ],
  [
    "0015_add_notification_token_hash.sql",
    "Session 20's security fix, first half. The DELETE removes " +
      "notification endpoints that hold neither a plaintext token nor a " +
      "hash — unusable rows that cannot be recovered, since the plaintext " +
      "was never stored anywhere else. Deleting is the honest outcome; the " +
      "owner re-mints from the UI. Same never-deployed reasoning as 0016.",
  ],
  [
    "0016_drop_notification_plaintext_token.sql",
    "Session 20's security fix. Drops the plaintext notification token " +
      "column after 0015 added the hash — the whole point was that storing " +
      "the plaintext was the defect, so keeping it for rollback safety " +
      "would have preserved the vulnerability. Predates any deployment: " +
      "IDent has never been deployed, so no released code has run against " +
      "either schema. Not a precedent.",
  ],
]);

if (!existsSync(MIGRATIONS_DIR)) {
  console.error(`No migrations directory at ${MIGRATIONS_DIR}`);
  process.exit(2);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const problems = [];
const allowed = [];

for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  // Comments can legitimately contain the words this looks for.
  const withoutComments = sql.replace(/--[^\n]*/g, "");

  for (const { name, pattern } of DESTRUCTIVE_PATTERNS) {
    if (!pattern.test(withoutComments)) continue;
    if (ALLOWLIST.has(file)) {
      allowed.push({ file, name, reason: ALLOWLIST.get(file) });
      continue;
    }
    problems.push({ file, name });
  }
}

for (const { file, name, reason } of allowed) {
  console.log(`  ALLOWED  ${file}\n           ${name}\n           ${reason}`);
}

if (problems.length > 0) {
  console.error("\nMigrations that would break the previous release's code:\n");
  for (const { file, name } of problems) console.error(`  ${file}: ${name}`);
  console.error(
    "\nRolling back is 'redeploy the last good build', which does not undo a migration.\n" +
      "Split this into an additive migration now and a destructive one a release later,\n" +
      "or add it to the allowlist in this script with an argument for why it is safe.",
  );
  process.exit(1);
}

console.log(`\nChecked ${files.length} migrations. No unreviewed destructive migrations.`);
console.log("Rolling back to the previous release is safe with respect to schema.");
