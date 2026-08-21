#!/usr/bin/env node
/**
 * Session 23a — settle whether the production backup is a backup of
 * production.
 *
 * The Session 23 restore rehearsal recovered **zero identities** from a
 * database that the `omartest` identity had registered against earlier in
 * the same session (DEPLOYMENT.md §6). Both cannot be true. Either the
 * dump predates `omartest`, or it was taken from a database the API does
 * not write to — and the second would mean the archive is not a backup of
 * production at all.
 *
 * Until that is settled, the rehearsal proves the schema and the migration
 * history round-trip and **nothing about data**. A restore verified
 * against an empty dataset cannot show that rows survive it, which is the
 * one thing a backup exists to do.
 *
 * So this takes a fresh dump, restores it into a throwaway container, and
 * compares row counts on both sides. It answers one question — *do the
 * rows that are in production come back out of the archive?* — and prints
 * a verdict rather than numbers to interpret.
 *
 * It never writes to the source. Every statement it runs against
 * production is a SELECT, and the restore happens in a container it
 * created and deletes.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' node scripts/reconcile-backup.mjs
 *   DATABASE_URL='postgresql://...' node scripts/reconcile-backup.mjs --keep-dump ./backups
 *
 * The connection string comes from the environment and never from argv,
 * so it stays out of shell history and out of the process list other
 * users on the machine can read.
 *
 * Requires Docker. The client version has to match the server's major
 * version — Neon is Postgres 18 — and running both inside `postgres:18`
 * is what guarantees that without installing anything on the host.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const sourceUrl = process.env.DATABASE_URL;
const keepDumpDir = valueOf("--keep-dump");
const image = valueOf("--image") ?? "postgres:18";

/**
 * The tables whose counts decide the verdict. `identities` is the one the
 * discrepancy is about; the other two are included because a dump that
 * silently captured a different database would be unlikely to match on
 * all three at once.
 */
const COUNTED_TABLES = [
  "public.identities",
  "public.system_health_checks",
  // Drizzle keeps its ledger in its own schema, not `public` — unqualified
  // it reads as absent, which looks like a match when both sides miss it.
  "drizzle.__drizzle_migrations",
];

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (!sourceUrl) {
  console.error("DATABASE_URL is required (the production connection string).");
  console.error("Read it from Railway: the `@ident/api` service, Variables tab.");
  console.error("");
  console.error("usage: DATABASE_URL='postgresql://...' node scripts/reconcile-backup.mjs [--keep-dump <dir>] [--image postgres:18]");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const container = `ident-reconcile-${Date.now()}`;
const scratchDb = "ident_restore_check";
const dumpPath = `/tmp/ident-${stamp}.dump`;

/** Runs a command and resolves with its stdout, rejecting on a non-zero exit. */
function run(command, commandArgs, { allowFailure = false, env } = {}) {
  const child = spawn(command, commandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });

  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));

  return new Promise((resolveRun, rejectRun) => {
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) return resolveRun({ code, out, err });
      rejectRun(new Error(`${command} ${commandArgs.join(" ")} failed (${code})\n${err.trim()}`));
    });
  });
}

/** Runs a command inside the throwaway container. */
function inContainer(command, commandArgs, options) {
  return run("docker", ["exec", container, command, ...commandArgs], options);
}

/**
 * One SELECT count(*), against whichever database is named. Returns null
 * for a table that does not exist, which is itself an answer worth
 * printing rather than an error worth crashing on.
 */
async function countRows(connection, table) {
  // Quoted per part, so `drizzle.__drizzle_migrations` stays a schema and a
  // table rather than one implausible identifier.
  const quoted = table.split(".").map((part) => `"${part}"`).join(".");
  const { code, out } = await inContainer(
    "psql",
    [connection, "-tAc", `SELECT count(*) FROM ${quoted}`],
    { allowFailure: true },
  );
  if (code !== 0) return null;
  return Number(out.trim());
}

function formatCount(value) {
  return value === null ? "absent" : String(value);
}

async function main() {
  console.log("Reconciling the production archive against production itself.\n");

  // A container of our own, so nothing depends on what is already running
  // and nothing outlives the check.
  console.log(`Starting ${image} as ${container}`);
  await run("docker", [
    "run", "-d", "--name", container,
    "-e", "POSTGRES_PASSWORD=reconcile",
    "-e", "POSTGRES_USER=reconcile",
    "-e", "POSTGRES_DB=reconcile",
    image,
  ]);

  try {
    process.stdout.write("Waiting for it to accept connections");
    for (let attempt = 0; ; attempt += 1) {
      const { code } = await inContainer("pg_isready", ["-U", "reconcile"], { allowFailure: true });
      if (code === 0) break;
      if (attempt > 60) throw new Error("the container never became ready");
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(" ready\n");

    const localAdmin = "postgresql://reconcile:reconcile@localhost:5432/reconcile";
    const localScratch = `postgresql://reconcile:reconcile@localhost:5432/${scratchDb}`;

    // 1. Production, read-only.
    console.log("Counting rows in production (SELECT only)");
    const productionCounts = {};
    for (const table of COUNTED_TABLES) {
      productionCounts[table] = await countRows(sourceUrl, table);
      console.log(`  ${table.padEnd(30)} ${formatCount(productionCounts[table])}`);
    }

    // 2. A dump taken now, not the one from the rehearsal.
    console.log("\nTaking a fresh custom-format dump");
    await inContainer("pg_dump", [
      sourceUrl, "--format=custom", "--no-owner", "--no-privileges", "--file", dumpPath,
    ]);
    const { out: sizeOut } = await inContainer("stat", ["-c", "%s", dumpPath]);
    const dumpBytes = Number(sizeOut.trim());
    console.log(`  ${dumpBytes.toLocaleString()} bytes`);

    // 3. Restore it somewhere isolated.
    console.log(`\nRestoring into a scratch database (${scratchDb})`);
    await inContainer("createdb", ["-U", "reconcile", scratchDb]);
    await inContainer("pg_restore", [
      "--dbname", localScratch, "--no-owner", "--no-privileges", dumpPath,
    ], { allowFailure: true });

    console.log("Counting rows in the restore");
    const restoredCounts = {};
    for (const table of COUNTED_TABLES) {
      restoredCounts[table] = await countRows(localScratch, table);
      console.log(`  ${table.padEnd(30)} ${formatCount(restoredCounts[table])}`);
    }

    // 4. The checksum, so the archive can be identified later.
    let checksum = null;
    if (keepDumpDir) {
      const outDir = resolve(keepDumpDir);
      await mkdir(outDir, { recursive: true });
      const hostPath = join(outDir, `ident-production-${stamp}.dump`);
      await run("docker", ["cp", `${container}:${dumpPath}`, hostPath]);
      checksum = createHash("sha256").update(await readFile(hostPath)).digest("hex");
      console.log(`\nArchive kept at ${hostPath}`);
      console.log(`SHA-256: ${checksum}`);
    }

    // 5. The verdict.
    console.log("\n" + "-".repeat(62));
    const mismatches = COUNTED_TABLES.filter((t) => productionCounts[t] !== restoredCounts[t]);
    const identities = productionCounts["public.identities"];

    if (mismatches.length > 0) {
      console.log("MISMATCH — the archive does not contain what production contains.");
      for (const table of mismatches) {
        console.log(`  ${table}: production ${formatCount(productionCounts[table])}, restored ${formatCount(restoredCounts[table])}`);
      }
      console.log("\nThis is the bad outcome. The archive is not a faithful copy of");
      console.log("production, so DEPLOYMENT.md §6 cannot claim a working backup.");
      process.exitCode = 1;
      return;
    }

    if (identities === null) {
      console.log("NO `identities` TABLE — this is not the IDent production database.");
      console.log("");
      console.log("Every counted table was absent on both sides, so they trivially");
      console.log("agree. Check DATABASE_URL before reading anything into that.");
      process.exitCode = 1;
      return;
    }

    if (identities === 0) {
      console.log("MATCHED, but production holds zero identities.");
      console.log("");
      console.log("The counts agree, so the dump and the restore are consistent —");
      console.log("but they agree on nothing. This does not settle the question:");
      console.log("if `omartest` should exist and does not, the problem is that");
      console.log("DATABASE_URL points somewhere the API does not write, and the");
      console.log("same wrong database was dumped. Check that this connection");
      console.log("string is the one the Railway service actually uses before");
      console.log("recording anything.");
      process.exitCode = 1;
      return;
    }

    console.log("RECONCILED — every counted table round-trips.");
    console.log(`  identities: ${identities}, and they survive a dump and restore.`);
    console.log("");
    console.log("Record these numbers in DEPLOYMENT.md §6 and remove the caveat.");
    if (checksum) console.log(`  SHA-256: ${checksum}`);
  } finally {
    console.log("\nRemoving the container");
    await run("docker", ["rm", "-f", container], { allowFailure: true });
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  run("docker", ["rm", "-f", container], { allowFailure: true }).finally(() => process.exit(1));
});
