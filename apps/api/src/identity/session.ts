import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

// Base session per SECURITY.md's tiering: unlocks Low/Medium tier modules
// only, High/Critical need a separate, shorter-lived step-up (not built yet —
// see IDent_STATE.md's future-gaps log). No refresh-token flow exists yet
// either, so this is the whole session lifetime, not an access-token half of
// one; revisit once multi-device UX needs silent renewal.
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

// Step-up / elevated-session window (SECURITY.md's tiering): re-entering a
// factor unlocks High/Critical-tier routes for this long, much shorter than
// the 24h base session. Not a separate token — see sessions.elevatedUntil
// in db/schema.ts and identity/elevation.ts's requireElevatedSession.
export const ELEVATION_TTL_MS = 1000 * 60 * 5;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

// Only this hash is ever persisted — the raw token returned at issuance
// can't be recovered from the sessions table, so a DB read alone can't
// impersonate a session.
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
