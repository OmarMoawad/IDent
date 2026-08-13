// Dev/CI defaults only, same convention as identity/webauthn-config.ts —
// GOOGLE_OAUTH_CLIENT_ID/SECRET have no sane default (they're real
// per-project Google credentials, set in .env, never committed) and are
// only actually required once a route calls the real GoogleOAuthClient;
// tests never touch these, they inject a fake client instead (see
// comms/test-support/fake-google-oauth-client.ts).
export const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
export const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
export const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://localhost:4000/identity/connections/gmail/callback";

// Read-only, nothing more — IDent_STATE.md's session-2 pre-connector
// checklist calls for the minimum scope the sync actually needs, not a
// broad grant "in case it's useful later."
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// How long an OAuth state challenge stays valid — long enough to get
// through Google's consent screen, short enough that an abandoned flow's
// state can't be replayed hours later.
export const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;

// A refresh happens this far before the access token's real expiry, so a
// sync job never starts a request with a token that expires mid-flight.
export const ACCESS_TOKEN_REFRESH_BUFFER_MS = 1000 * 60 * 2;

// Session 15: how many of the most recent messages a single on-demand sync
// pulls. On-demand (not a background job) per IDent_STATE.md's session-14.5
// design note — a user-triggered "Sync now" action, not a poller — so this
// bounds one HTTP request's Gmail API calls (1 list + up to this many gets)
// to something that finishes within a normal request timeout, not a
// long-term inbox size limit.
export const GMAIL_SYNC_MAX_MESSAGES = 25;

/**
 * Symmetric key for encrypting connected_sources.encrypted_token_data at
 * rest (AES-256-GCM — see token-encryption.ts). The dev-only fallback
 * below is a real, valid 32-byte key generated once for local dev/CI, the
 * same pattern db/pool.ts and identity/webauthn-config.ts already use for
 * their own dev defaults — this repo's hard gate (IDent_STATE.md) still
 * blocks any real account/token data from existing anywhere beyond local
 * dev, so a shared dev-only key here carries the same "no real secrets
 * yet" assumption everything else in local dev already relies on. Set
 * COMMS_TOKEN_ENCRYPTION_KEY to a real per-environment key (base64,
 * 32 bytes) before that gate is ever lifted.
 *
 * `??` is deliberately not used here: .env.example ships this key blank
 * (`COMMS_TOKEN_ENCRYPTION_KEY=`), so DEVELOPMENT.md's own documented
 * setup step — `cp .env.example .env` — makes dotenv define it as an
 * empty string. `?? ` treats that as "set", the empty string decodes to
 * zero bytes, and token-encryption.ts throws at import time, so the API
 * refused to boot on a clean checkout. Found by the session 17
 * real-browser click-through; the same class of "env silently wrong,
 * only visible when actually running it" bug as the dotenv-path fix in
 * item 2.5. A blank value means "not configured", identical to unset.
 */
export const COMMS_TOKEN_ENCRYPTION_KEY_BASE64 =
  process.env.COMMS_TOKEN_ENCRYPTION_KEY?.trim() || "lsA98LvDoz3c0P6DI7UUa6vYkD4Py7LzFhlPT7+787U=";
