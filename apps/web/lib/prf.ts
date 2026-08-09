/**
 * WebAuthn PRF extension support: derives a real AES-GCM key from a
 * passkey's per-authenticator PRF secret, replacing the honest
 * "prf-not-yet-implemented" placeholder this file's earlier absence forced
 * (see IDent_STATE.md). Registration uses a two-step create()-then-get()
 * ceremony because create()-time PRF results aren't reliably returned
 * across browsers/authenticators (Safari in particular needs the eval in a
 * get()); login evaluates PRF in the very get() ceremony the server already
 * runs for authentication (apps/api's getAuthenticationOptions requests
 * it), so it costs no extra user gesture.
 */

import type {
  AuthenticationExtensionsClientInputs,
  AuthenticationResponseJSON,
  Base64URLString,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { startAuthentication } from "@simplewebauthn/browser";
import { fromBase64Url, toBase64Url } from "./amk";

// Must match apps/api/src/identity/webauthn-config.ts's PRF_SALT_LABEL —
// both sides independently SHA-256 the same public label rather than
// sharing a hardcoded byte array, so the two copies can't silently drift.
const PRF_SALT_LABEL = "IDent AMK wrap salt v1";
// HKDF context string, domain-separating this key from any other future
// use of the same PRF output (e.g. if a second PRF-derived secret is ever
// needed for something else on the same credential).
const HKDF_INFO = "IDent AMK wrap (passkey PRF) v1";
const IV_BYTES = 12;

async function prfSaltBytes(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PRF_SALT_LABEL));
  return new Uint8Array(digest);
}

/**
 * The WebAuthn PRF extension's `eval.first` is spec'd as `BufferSource`
 * (raw bytes), not a base64url string — `navigator.credentials.create()`/
 * `.get()` throw a `TypeError` if it's handed a string. `@simplewebauthn/
 * browser` doesn't know about the `prf` extension, so unlike `challenge`
 * (which it explicitly decodes) it passes `extensions` straight through
 * from `optionsJSON`. The server's options JSON necessarily carries
 * `eval.first` as base64url (JSON has no byte type), so this decodes it
 * back to bytes right before the real WebAuthn call — see login/page.tsx.
 */
export function decodePrfEvalExtensions(
  extensions: AuthenticationExtensionsClientInputs | undefined,
): AuthenticationExtensionsClientInputs | undefined {
  const withPrf = extensions as { prf?: { eval?: { first?: unknown } } } | undefined;
  const first = withPrf?.prf?.eval?.first;
  if (typeof first !== "string") return extensions;
  return { ...extensions, prf: { eval: { first: fromBase64Url(first) } } } as unknown as AuthenticationExtensionsClientInputs;
}

/**
 * PRF output is already fresh, high-entropy, authenticator-bound keying
 * material — HKDF-Extract with an empty salt (RFC 5869 §2.2 explicitly
 * allows this) is standard practice for IKM that's already unique per use,
 * so no extra random salt is needed here on top of it.
 */
async function deriveKeyFromPrfOutput(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Produces the opaque blob sent as `wrappedAmkKey` for the passkey factor — iv(12) || ciphertext, base64url. */
export async function wrapAmkWithPrfOutput(amk: Uint8Array, prfOutput: ArrayBuffer): Promise<string> {
  const key = await deriveKeyFromPrfOutput(prfOutput);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, amk as BufferSource),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return toBase64Url(combined);
}

export class PrfUnwrapError extends Error {
  constructor() {
    super("Could not unlock the Account Master Key with this passkey.");
    this.name = "PrfUnwrapError";
  }
}

export async function unwrapAmkWithPrfOutput(wrappedBlob: string, prfOutput: ArrayBuffer): Promise<Uint8Array> {
  const combined = fromBase64Url(wrappedBlob);
  const iv = combined.subarray(0, IV_BYTES);
  const ciphertext = combined.subarray(IV_BYTES);
  const key = await deriveKeyFromPrfOutput(prfOutput);
  try {
    const amk = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
    return new Uint8Array(amk);
  } catch {
    // Same reasoning as unwrapAmk's IncorrectPasswordError: AES-GCM's auth
    // tag failing is the expected shape of "wrong secret" here too (wrong
    // passkey, or a placeholder blob that was never real ciphertext).
    throw new PrfUnwrapError();
  }
}

/** Stored when a passkey can't (or wasn't asked to) produce a real AMK wrap — see account/page.tsx. */
export const PRF_UNSUPPORTED_PLACEHOLDER = "prf-unsupported";
/** Stored when the authenticator supports PRF but the AMK wasn't loaded in memory at registration time. */
export const PRF_AMK_LOCKED_PLACEHOLDER = "amk-locked-at-registration";

export function isPrfPlaceholder(wrappedAmkKey: string): boolean {
  return wrappedAmkKey === PRF_UNSUPPORTED_PLACEHOLDER || wrappedAmkKey === PRF_AMK_LOCKED_PLACEHOLDER;
}

/**
 * @simplewebauthn/browser's bundled DOM type shim predates the WebAuthn PRF
 * extension (see apps/api/src/identity/webauthn-service.ts's matching
 * note) — these two helpers are the only places that need to reach past
 * that typing gap to the real, browser-supported `prf` extension fields.
 */
type PrfRegistrationOutputs = { prf?: { enabled?: boolean } };
type PrfAuthenticationOutputs = { prf?: { results?: { first?: ArrayBuffer } } };

export function isPrfEnabledAfterRegistration(response: RegistrationResponseJSON): boolean {
  return (response.clientExtensionResults as PrfRegistrationOutputs).prf?.enabled === true;
}

export function prfOutputFromAssertion(response: AuthenticationResponseJSON): ArrayBuffer | null {
  return (response.clientExtensionResults as PrfAuthenticationOutputs).prf?.results?.first ?? null;
}

/**
 * A local-only WebAuthn ceremony — no server round trip, because nothing
 * here needs server verification: the caller already holds a valid session
 * and (usually) the AMK in memory, and this exists purely to pull the new
 * credential's PRF output so the AMK can be wrapped with it. Run
 * immediately after registering a passkey, as the required second
 * ceremony/gesture (see this file's header comment for why create()-time
 * PRF isn't relied on directly).
 */
export async function getPrfOutputForNewCredential(credentialId: Base64URLString): Promise<ArrayBuffer | null> {
  // Raw bytes, not base64url — this ceremony is local-only and never
  // crosses JSON/HTTP, so `eval.first` can (and per spec must) stay a
  // BufferSource all the way to navigator.credentials.get().
  const salt = await prfSaltBytes();
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const assertion = await startAuthentication({
    optionsJSON: {
      challenge,
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "preferred",
      extensions: { prf: { eval: { first: salt } } } as unknown as AuthenticationExtensionsClientInputs,
    },
  });
  return prfOutputFromAssertion(assertion);
}

/**
 * Same local-only-ceremony idea as getPrfOutputForNewCredential, but for
 * unlocking an already-registered passkey's AMK wrap from the account page
 * (as opposed to logging in) — no allowCredentials restriction, so the
 * browser's own passkey picker decides which credential to use, and the
 * returned id tells the caller which wrap to fetch.
 */
export async function getPrfOutputForUnlock(): Promise<{ credentialId: Base64URLString; prfOutput: ArrayBuffer } | null> {
  // Same raw-bytes reasoning as getPrfOutputForNewCredential above.
  const salt = await prfSaltBytes();
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const assertion = await startAuthentication({
    optionsJSON: {
      challenge,
      userVerification: "preferred",
      extensions: { prf: { eval: { first: salt } } } as unknown as AuthenticationExtensionsClientInputs,
    },
  });
  const prfOutput = prfOutputFromAssertion(assertion);
  return prfOutput ? { credentialId: assertion.id, prfOutput } : null;
}
