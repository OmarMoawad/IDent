import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { buildProvenance } from "./readiness.js";

/**
 * Session 23a. The point of reporting a commit is to answer "what is
 * actually serving" without trusting a platform dashboard, so the cases
 * that matter are the ones where the answer is *unknown* — an absent
 * field is honest, a guessed one is not.
 */
describe("build provenance", () => {
  it("reports the commit and branch the platform injected", () => {
    expect(
      buildProvenance({ RAILWAY_GIT_COMMIT_SHA: "abc123", RAILWAY_GIT_BRANCH: "main" } as NodeJS.ProcessEnv),
    ).toEqual({ commit: "abc123", branch: "main" });
  });

  it("reads Vercel's variables too, so the check survives a move", () => {
    expect(
      buildProvenance({ VERCEL_GIT_COMMIT_SHA: "def456", VERCEL_GIT_COMMIT_REF: "main" } as NodeJS.ProcessEnv),
    ).toEqual({ commit: "def456", branch: "main" });
  });

  it("omits what it does not know rather than inventing 'unknown'", () => {
    expect(buildProvenance({} as NodeJS.ProcessEnv)).toEqual({});
    // A blank variable is not a commit; it is a variable someone set to nothing.
    expect(buildProvenance({ RAILWAY_GIT_COMMIT_SHA: "   " } as NodeJS.ProcessEnv)).toEqual({});
  });

  it("prefers an explicit override where no platform sets one", () => {
    expect(buildProvenance({ GIT_COMMIT_SHA: "ghi789" } as NodeJS.ProcessEnv)).toEqual({
      commit: "ghi789",
    });
  });
});

describe("/health carries the provenance", () => {
  it("omits the field entirely when nothing injected one", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    const payload = JSON.parse(response.body);
    // Locally there is no platform, so asserting absence is asserting the
    // behaviour that keeps the field trustworthy when it *is* present.
    expect(payload).not.toHaveProperty("commit");
    expect(payload.db).toBeDefined();
  });
});
