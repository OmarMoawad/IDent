// Dev/CI defaults only — WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be set to
// the real deployed domain once one exists (WebAuthn binds credentials to
// the origin they were created on; a mismatch here means every credential
// silently stops verifying, not an obvious error at registration time).
export const RP_NAME = "IDent";
export const RP_ID = process.env.WEBAUTHN_RP_ID ?? "localhost";
export const ORIGIN = process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000";

export const CHALLENGE_TTL_MS = 1000 * 60 * 5;

/**
 * Public, non-secret input to the WebAuthn PRF extension's `eval.first`.
 * Fixes which PRF output an authenticator derives, so the registration-time
 * probe (apps/web/lib/prf.ts) and every later login ask the same credential
 * for the same secret — the actual AMK-wrapping key comes from the
 * authenticator's PRF *output*, which never reaches this server. Derived by
 * hashing a fixed label (rather than hardcoding raw bytes) so this file and
 * apps/web/lib/prf.ts's independent copy can't silently drift apart — both
 * compute SHA-256 of the same literal string.
 */
export const PRF_SALT_LABEL = "IDent AMK wrap salt v1";

let cachedPrfSaltBase64Url: Promise<string> | undefined;
export function getPrfSaltBase64Url(): Promise<string> {
  if (!cachedPrfSaltBase64Url) {
    cachedPrfSaltBase64Url = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(PRF_SALT_LABEL))
      .then((digest) => Buffer.from(digest).toString("base64url"));
  }
  return cachedPrfSaltBase64Url;
}
