import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 2 session 5 — the import boundary that keeps model-facing code away
 * from the write path.
 *
 * The capability design only holds if the assistant's client and
 * orchestration modules cannot *reach* an executor or a provider write
 * client directly — they must receive proposal/execution capabilities as
 * injected interfaces. This test enforces that structurally: it reads the
 * model-facing source and fails if any of it imports an executor or a
 * Google write client. It is the strong replacement for the older
 * "static seam scan", which is kept only as a secondary tripwire.
 */

const assistantDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The modules a model response flows through — none may import a writer. */
const MODEL_FACING = [
  "assistant-service.ts",
  "assistant-retrieval.ts",
  "assistant-client.ts",
  "claude-client.ts",
  "openai-compatible-client.ts",
  "assistant-intent.ts",
];

/** Import specifiers that would put a write path in a model-facing module. */
const FORBIDDEN_IMPORTS = [
  "write-actions/executors",
  "google-mail-write-client",
  "google-calendar-write-client",
];

describe("assistant model-facing modules never import a writer", () => {
  it("keeps executors and provider write clients out of the model seam", () => {
    for (const file of MODEL_FACING) {
      const source = readFileSync(join(assistantDir, file), "utf8");
      // Only lines that actually import — a comment mentioning the name is fine.
      const importLines = source
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+["']/.test(line));
      for (const forbidden of FORBIDDEN_IMPORTS) {
        for (const line of importLines) {
          expect(line, `${file} must not import ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });

  it("lists a real set of model-facing files (guards against a renamed-away seam)", () => {
    const present = new Set(readdirSync(assistantDir));
    for (const file of MODEL_FACING) {
      expect(present.has(file), `${file} should exist to be checked`).toBe(true);
    }
  });
});
