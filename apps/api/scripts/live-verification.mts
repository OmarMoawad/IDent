import "../src/load-env.js";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLiveVerificationArtifact } from "../src/assistant/write-actions/live-verification.js";

/**
 * Runs the three v1 write actions against the connected Google account and
 * writes a sanitized live-verification artifact to
 * `docs/live-verification/<timestamp>.json`.
 *
 * Prerequisites: local Postgres up, migrations applied, and a Google source
 * reconnected with `gmail.modify` + `calendar.events`. A random per-run salt
 * means target refs cannot be correlated across artifacts or back to a real
 * id. Run from the repo: `npm run verify:live -w apps/api`.
 */
function commit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(repoRoot, "docs/live-verification");

const artifact = await generateLiveVerificationArtifact({
  commit: commit(),
  salt: randomBytes(16).toString("hex"),
});

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${artifact.generatedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

console.log(JSON.stringify(artifact, null, 2));
console.log(`\nWrote ${outPath}`);
process.exit(0);
