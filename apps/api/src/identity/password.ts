import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// util.promisify(scrypt) loses the options-object overload's typing, so
// wrap it by hand instead of fighting that with casts.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const KEY_LENGTH = 64;
// OWASP's current interactive-login minimum. Costs ~128 MiB per hash
// (128 * N * r bytes) — that memory cost is scrypt's entire defense against
// GPU/ASIC cracking, not overhead to trim.
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * Encodes as `scrypt$N$r$p$salt$hash` (all base64url) so params travel with
 * the hash — required to verify old hashes after SCRYPT_PARAMS is tuned up.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  const derivedKey = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return derivedKey.length === expected.length && timingSafeEqual(derivedKey, expected);
}
