import { isDeployedEnvironment } from "../deployment.js";

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

// Session 17b: Google Calendar, requested on the *same* Google connection
// rather than as a second provider — decided when this session started, as
// the cadence entry asked. One consent screen, one token to refresh, one
// disconnect that revokes both; a second connection to the same account
// would double all three for no user-visible benefit.
//
// The cost of that choice, stated plainly: adding a scope invalidates
// existing grants, so a source connected before this session has Gmail
// access only and must be reconnected to gain calendar access. That is why
// the granted scope is checked at read time (see hasCalendarScope) instead
// of being assumed from the connection existing.
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** Everything the connect flow asks for, space-separated as Google expects. */
export const GOOGLE_OAUTH_SCOPES = [GMAIL_SCOPE, GOOGLE_CALENDAR_SCOPE].join(" ");

/**
 * Whether a stored grant actually includes calendar access. Google returns
 * the granted scopes on the token response, and a user can decline
 * individual scopes on the consent screen, so this must be checked rather
 * than inferred.
 */
export function hasCalendarScope(grantedScope: string | null | undefined): boolean {
  return (grantedScope ?? "").split(/\s+/).includes(GOOGLE_CALENDAR_SCOPE);
}

// How many events one on-demand calendar sync pulls, same bounded
// user-triggered shape as GMAIL_SYNC_MAX_MESSAGES.
export const CALENDAR_SYNC_MAX_EVENTS = 50;

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
 * The local-dev key for `connected_sources.encrypted_token_data`
 * (AES-256-GCM — see token-encryption.ts).
 *
 * It is **committed, therefore public**, and exists only so a clean
 * checkout boots and the connect flow works without configuration.
 * It must never encrypt a real token: a Google refresh token is a
 * long-lived credential to somebody's whole mailbox, and encrypting it
 * under a key anyone can read from this repository is equivalent to
 * storing it in plaintext.
 */
const DEV_ONLY_KEY_BASE64 = "lsA98LvDoz3c0P6DI7UUa6vYkD4Py7LzFhlPT7+787U=";

export class InsecureEncryptionKeyError extends Error {
  constructor() {
    super(
      "COMMS_TOKEN_ENCRYPTION_KEY must be set to a unique 32-byte base64 key in any deployed environment. " +
        "The built-in development key is committed to this repository and must never encrypt real tokens.",
    );
    this.name = "InsecureEncryptionKeyError";
  }
}

/**
 * Session 22b, external-review item 3. Until this session the constant
 * below simply fell back to the committed key everywhere, so a deployment
 * that forgot `COMMS_TOKEN_ENCRYPTION_KEY` encrypted real refresh tokens
 * under a public key and reported nothing at all. Now it **fails closed**
 * off local development: missing, blank, wrong-length, or explicitly set
 * to the public dev key are all refusals.
 *
 * `?.trim() ||` rather than `??` is deliberate and load-bearing:
 * .env.example ships this key blank (`COMMS_TOKEN_ENCRYPTION_KEY=`), so
 * DEVELOPMENT.md's own documented `cp .env.example .env` makes dotenv
 * define it as an empty string. `??` treats that as "set", the empty
 * string decodes to zero bytes, and the API refused to boot on a clean
 * checkout — found by the session 17 real-browser click-through. A blank
 * value means "not configured", identical to unset.
 */
export function resolveTokenEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.COMMS_TOKEN_ENCRYPTION_KEY?.trim();

  if (!configured) {
    if (isDeployedEnvironment(env)) throw new InsecureEncryptionKeyError();
    return Buffer.from(DEV_ONLY_KEY_BASE64, "base64");
  }

  const key = Buffer.from(configured, "base64");
  if (key.length !== 32) {
    throw new Error("COMMS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  }
  // Setting the public dev key explicitly is the same hazard as omitting it.
  if (isDeployedEnvironment(env) && key.equals(Buffer.from(DEV_ONLY_KEY_BASE64, "base64"))) {
    throw new InsecureEncryptionKeyError();
  }
  return key;
}
