import { randomInt } from "node:crypto";

// Crockford base32 minus the ambiguous-looking characters it already
// excludes (I, L, O, U) — every remaining character is visually distinct
// even handwritten, since a recovery code is meant to be copied down once
// and typed back in under stress (lost device, locked out).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_LENGTH = 5;
const GROUP_COUNT = 4;

/**
 * Server-generated, not user-chosen — unlike a password, nothing about this
 * secret needs to be memorable, so it's optimized purely for entropy
 * (32^20 ≈ 100 bits, far above the password minimum) and low transcription
 * error. Formatted `XXXXX-XXXXX-XXXXX-XXXXX` for readability; the hyphens
 * are stripped before hashing/verifying so pasting with or without them
 * both work.
 */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, "");
}
