// Dev/CI defaults only — WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be set to
// the real deployed domain once one exists (WebAuthn binds credentials to
// the origin they were created on; a mismatch here means every credential
// silently stops verifying, not an obvious error at registration time).
export const RP_NAME = "IDent";
export const RP_ID = process.env.WEBAUTHN_RP_ID ?? "localhost";
export const ORIGIN = process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000";

export const CHALLENGE_TTL_MS = 1000 * 60 * 5;
