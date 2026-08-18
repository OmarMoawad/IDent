import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolveTokenEncryptionKey } from "./comms-config.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce size
const AUTH_TAG_BYTES = 16;

/**
 * Resolved on first use rather than at import time. An import-time throw
 * would take down every route in the process — including `/health`, the
 * endpoint whose job is to *report* a misconfiguration — so a deployment
 * missing its key would go dark instead of saying why. Receiptless's
 * oauth-token-crypto.ts makes the same choice for the same reason; this
 * is the port of it (session 22b, review item 3).
 *
 * Cached after the first successful resolution: the key does not change
 * within a process, and re-deriving it per call would put a base64 decode
 * on every message sync.
 */
let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  cachedKey ??= resolveTokenEncryptionKey();
  return cachedKey;
}

/**
 * Encrypts an OAuth token payload (see comms-config.ts) for storage in
 * connected_sources.encrypted_token_data. iv + authTag + ciphertext are
 * packed into one base64url blob — same "pack together, one opaque
 * column" convention as apps/web/lib/amk.ts's salt+iv+ciphertext blob —
 * so the column stays a single opaque string, never structured plaintext.
 */
export function encryptTokenPayload(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

export class TokenDecryptionError extends Error {
  constructor() {
    super("Could not decrypt token payload — wrong key, or the ciphertext was tampered with.");
    this.name = "TokenDecryptionError";
  }
}

/**
 * Decrypts a payload encryptTokenPayload produced. GCM's auth tag means a
 * single flipped bit anywhere in a tampered blob fails verification here
 * rather than silently returning corrupted plaintext — same "don't let
 * malformed/attacker-controlled input succeed quietly" discipline as
 * identity/webauthn-service.ts's verify functions.
 */
export function decryptTokenPayload(packed: string): string {
  let buf: Buffer;
  try {
    buf = Buffer.from(packed, "base64url");
  } catch {
    throw new TokenDecryptionError();
  }
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) throw new TokenDecryptionError();

  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new TokenDecryptionError();
  }
}
