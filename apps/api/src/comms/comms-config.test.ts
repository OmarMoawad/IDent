import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the session 17 click-through finding: .env.example
 * ships COMMS_TOKEN_ENCRYPTION_KEY blank, so DEVELOPMENT.md's documented
 * `cp .env.example .env` made dotenv define it as "". With `??` that counted
 * as configured, decoded to zero bytes, and token-encryption.ts threw at
 * import time — the API would not boot on a clean checkout.
 */
async function loadKey(): Promise<string> {
  vi.resetModules();
  const { COMMS_TOKEN_ENCRYPTION_KEY_BASE64 } = await import("./comms-config.js");
  return COMMS_TOKEN_ENCRYPTION_KEY_BASE64;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("COMMS_TOKEN_ENCRYPTION_KEY_BASE64", () => {
  it("falls back to the dev key when the variable is unset", async () => {
    vi.stubEnv("COMMS_TOKEN_ENCRYPTION_KEY", undefined);
    expect(Buffer.from(await loadKey(), "base64")).toHaveLength(32);
  });

  it("treats a blank value as unset, so a copied .env.example still boots", async () => {
    vi.stubEnv("COMMS_TOKEN_ENCRYPTION_KEY", "");
    expect(Buffer.from(await loadKey(), "base64")).toHaveLength(32);
  });

  it("treats a whitespace-only value as unset too", async () => {
    vi.stubEnv("COMMS_TOKEN_ENCRYPTION_KEY", "   ");
    expect(Buffer.from(await loadKey(), "base64")).toHaveLength(32);
  });

  it("uses a real configured key when one is supplied", async () => {
    const configured = Buffer.alloc(32, 7).toString("base64");
    vi.stubEnv("COMMS_TOKEN_ENCRYPTION_KEY", configured);
    expect(await loadKey()).toBe(configured);
  });
});
