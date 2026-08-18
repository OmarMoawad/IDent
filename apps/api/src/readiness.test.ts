import { describe, expect, it } from "vitest";
import { insecureProductionConfig, missingProductionConfig, readinessFrom } from "./readiness.js";

const local = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
const deployed = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://x/y",
  COMMS_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  WEBAUTHN_RP_ID: "ident.example",
  WEBAUTHN_ORIGIN: "https://ident.example",
} as NodeJS.ProcessEnv;

/**
 * External review item 4. A deployment can be up, reachable and answering
 * while missing the configuration that makes it safe to serve — these are
 * the checks that stop `/health` calling that "ok".
 */
describe("missingProductionConfig", () => {
  it("says nothing in local development", () => {
    expect(missingProductionConfig(local)).toEqual([]);
  });

  it("is empty for a fully configured deployment", () => {
    expect(missingProductionConfig(deployed)).toEqual([]);
  });

  it("reports everything missing at once, not one item per redeploy", () => {
    const bare = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(missingProductionConfig(bare)).toEqual([
      "DATABASE_URL",
      "COMMS_TOKEN_ENCRYPTION_KEY",
      "WEBAUTHN_RP_ID",
      "WEBAUTHN_ORIGIN",
    ]);
  });

  it("requires the WebAuthn origin, because the default silently breaks passkeys later", () => {
    const { WEBAUTHN_ORIGIN, ...withoutOrigin } = deployed as Record<string, string>;
    expect(missingProductionConfig(withoutOrigin as NodeJS.ProcessEnv)).toContain("WEBAUTHN_ORIGIN");
  });

  it("treats a half-configured Google OAuth setup as missing the rest", () => {
    const partial = { ...deployed, GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com" };
    expect(missingProductionConfig(partial)).toEqual(["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"]);
  });
});

describe("insecureProductionConfig", () => {
  it("is empty for a fully configured deployment", () => {
    expect(insecureProductionConfig(deployed)).toEqual([]);
  });

  it("flags the committed dev encryption key", () => {
    const withDevKey = { ...deployed, COMMS_TOKEN_ENCRYPTION_KEY: "lsA98LvDoz3c0P6DI7UUa6vYkD4Py7LzFhlPT7+787U=" };
    expect(insecureProductionConfig(withDevKey)).toContain("COMMS_TOKEN_ENCRYPTION_KEY");
  });

  it("flags WebAuthn still pointed at localhost", () => {
    const stillLocal = { ...deployed, WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGIN: "http://localhost:3000" };
    expect(insecureProductionConfig(stillLocal)).toEqual(
      expect.arrayContaining(["WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN"]),
    );
  });

  it("flags rate limiting switched off in a deployment", () => {
    // One variable that silently removes every limit in the service.
    expect(insecureProductionConfig({ ...deployed, RATE_LIMIT_ENFORCE: "0" })).toContain("RATE_LIMIT_ENFORCE");
  });
});

describe("readinessFrom", () => {
  it("is degraded when the database is unreachable, however good the config", () => {
    expect(readinessFrom("unreachable", deployed).status).toBe("degraded");
  });

  it("is degraded when configuration is missing, however healthy the database", () => {
    expect(readinessFrom("ok", { NODE_ENV: "production" } as NodeJS.ProcessEnv).status).toBe("degraded");
  });

  it("is ok when both hold", () => {
    expect(readinessFrom("ok", deployed)).toMatchObject({ status: "ok", missingConfig: [], insecureConfig: [] });
  });

  it("reports names and never values, since the endpoint is unauthenticated", () => {
    const secret = "lsA98LvDoz3c0P6DI7UUa6vYkD4Py7LzFhlPT7+787U=";
    const report = readinessFrom("ok", { ...deployed, COMMS_TOKEN_ENCRYPTION_KEY: secret });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.insecureConfig).toContain("COMMS_TOKEN_ENCRYPTION_KEY");
  });
});
