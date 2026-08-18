import { afterEach, describe, expect, it, vi } from "vitest";
import { InsecureEncryptionKeyError, resolveTokenEncryptionKey } from "./comms-config.js";

const DEV_KEY = "lsA98LvDoz3c0P6DI7UUa6vYkD4Py7LzFhlPT7+787U=";
const local = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
const deployed = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Regression coverage for the session 17 click-through finding: .env.example
 * ships COMMS_TOKEN_ENCRYPTION_KEY blank, so DEVELOPMENT.md's documented
 * `cp .env.example .env` made dotenv define it as "". With `??` that counted
 * as configured, decoded to zero bytes, and token-encryption.ts threw at
 * import time — the API would not boot on a clean checkout.
 */
describe("resolveTokenEncryptionKey, in local development", () => {
  it("falls back to the dev key when the variable is unset", () => {
    expect(resolveTokenEncryptionKey(local)).toHaveLength(32);
  });

  it("treats a blank value as unset, so a copied .env.example still boots", () => {
    expect(resolveTokenEncryptionKey({ ...local, COMMS_TOKEN_ENCRYPTION_KEY: "" })).toHaveLength(32);
  });

  it("treats a whitespace-only value as unset too", () => {
    expect(resolveTokenEncryptionKey({ ...local, COMMS_TOKEN_ENCRYPTION_KEY: "   " })).toHaveLength(32);
  });

  it("uses a real configured key when one is supplied", () => {
    const configured = Buffer.alloc(32, 7);
    const resolved = resolveTokenEncryptionKey({
      ...local,
      COMMS_TOKEN_ENCRYPTION_KEY: configured.toString("base64"),
    });
    expect(resolved.equals(configured)).toBe(true);
  });
});

/**
 * Session 22b, external-review item 3. The committed key is public; a
 * deployment must never encrypt a real Google refresh token with it.
 */
describe("resolveTokenEncryptionKey, in a deployed environment", () => {
  it("refuses to boot with no key rather than using the committed one", () => {
    expect(() => resolveTokenEncryptionKey(deployed)).toThrow(InsecureEncryptionKeyError);
  });

  it("refuses a blank key too — a copied .env.example is not configuration", () => {
    expect(() => resolveTokenEncryptionKey({ ...deployed, COMMS_TOKEN_ENCRYPTION_KEY: "  " })).toThrow(
      InsecureEncryptionKeyError,
    );
  });

  it("refuses the committed dev key even when it is set deliberately", () => {
    expect(() => resolveTokenEncryptionKey({ ...deployed, COMMS_TOKEN_ENCRYPTION_KEY: DEV_KEY })).toThrow(
      InsecureEncryptionKeyError,
    );
  });

  it("rejects a key that is the wrong length, rather than padding it", () => {
    expect(() => resolveTokenEncryptionKey({ ...deployed, COMMS_TOKEN_ENCRYPTION_KEY: "dG9vLXNob3J0" })).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("accepts a real per-environment key", () => {
    const configured = Buffer.alloc(32, 3).toString("base64");
    expect(resolveTokenEncryptionKey({ ...deployed, COMMS_TOKEN_ENCRYPTION_KEY: configured })).toHaveLength(32);
  });

  it("treats IDENT_ENV as deployed even when NODE_ENV is unset, as a bare node process has none", () => {
    expect(() => resolveTokenEncryptionKey({ IDENT_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      InsecureEncryptionKeyError,
    );
  });
});
