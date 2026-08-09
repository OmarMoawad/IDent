/**
 * Client-side Account Master Key (AMK) handling, per ARCHITECTURE.md's
 * Identity Core key hierarchy: the AMK is generated here, in the browser,
 * and never transmitted or reconstructible server-side — only its
 * password-wrapped form leaves this module. Phase 0 doesn't yet use the
 * AMK to encrypt any real module data; this exists to prove the mechanism
 * end to end (generate, wrap, send; fetch, unwrap) before anything depends
 * on it.
 */

const AMK_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
// OWASP's 2023 minimum for PBKDF2-HMAC-SHA256. Runs client-side once per
// register/login, not a hot path.
const PBKDF2_ITERATIONS = 600_000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateAmk(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AMK_BYTES));
}

async function deriveKek(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Produces the opaque blob sent as `wrappedAmkKey` — salt(16) || iv(12) || ciphertext, base64url. */
export async function wrapAmk(amk: Uint8Array, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const kek = await deriveKek(password, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, kek, amk as BufferSource),
  );

  const combined = new Uint8Array(salt.length + iv.length + ciphertext.length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(ciphertext, salt.length + iv.length);
  return toBase64Url(combined);
}

export class IncorrectPasswordError extends Error {
  constructor() {
    super("Could not unwrap the Account Master Key — wrong password, or the wrap is corrupt.");
    this.name = "IncorrectPasswordError";
  }
}

export async function unwrapAmk(wrappedBlob: string, password: string): Promise<Uint8Array> {
  const combined = fromBase64Url(wrappedBlob);
  const salt = combined.subarray(0, SALT_BYTES);
  const iv = combined.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = combined.subarray(SALT_BYTES + IV_BYTES);

  const kek = await deriveKek(password, salt);
  try {
    const amk = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, kek, ciphertext as BufferSource);
    return new Uint8Array(amk);
  } catch {
    // AES-GCM's auth tag check failing is the expected shape of "wrong
    // password" — WebCrypto throws OperationError either way, so there's
    // no finer-grained signal to pass through.
    throw new IncorrectPasswordError();
  }
}
