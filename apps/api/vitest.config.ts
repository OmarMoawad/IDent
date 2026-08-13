import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    /**
     * Every test file shares one real Postgres (no mocked DB), so the
     * suite is sensitive to resource contention rather than to CPU count.
     * It has now flaked twice for reasons that had nothing to do with the
     * code: argon2 timeouts under load, and — while developing local mode
     * — a 5 GB language model resident in memory starving the workers on
     * the same machine.
     *
     * Both times the failures looked like regressions and weren't. Capping
     * workers costs a little wall-clock and removes a class of false
     * signal that has already cost more than that in investigation.
     * Receiptless carries the same cap for the same reason.
     *
     * Raise this only alongside a real fix for the shared-database
     * contention (a schema or database per worker), not on its own.
     */
    maxWorkers: 4,
  },
});
