import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { COMMS_TOKEN_ENCRYPTION_KEY_BASE64 } from "./comms-config.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce size
const AUTH_TAG_BYTES = 16;

const key = Buffer.from(COMMS_TOKEN_ENCRYPTION_KEY_BASE64, "base64");
if (key.length !== 32) {
  throw new Error("COMMS_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
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
  const cipher = createCipheriv(ALGORITHM, key, iv);
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
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new TokenDecryptionError();
  }
}
