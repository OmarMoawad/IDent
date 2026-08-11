import { describe, expect, it } from "vitest";
import { TokenDecryptionError, decryptTokenPayload, encryptTokenPayload } from "./token-encryption.js";

describe("token-encryption", () => {
  it("round-trips a payload through encrypt then decrypt", () => {
    const payload = JSON.stringify({ accessToken: "ya29.fake", refreshToken: "1//fake", expiresAt: "2026-08-11T10:00:00Z" });
    const encrypted = encryptTokenPayload(payload);
    expect(encrypted).not.toContain("ya29.fake");
    expect(decryptTokenPayload(encrypted)).toBe(payload);
  });

  it("produces a different ciphertext each time (random IV), even for the same plaintext", () => {
    const payload = "same-plaintext";
    const first = encryptTokenPayload(payload);
    const second = encryptTokenPayload(payload);
    expect(first).not.toBe(second);
    expect(decryptTokenPayload(first)).toBe(payload);
    expect(decryptTokenPayload(second)).toBe(payload);
  });

  it("rejects a tampered ciphertext instead of returning corrupted plaintext", () => {
    const encrypted = encryptTokenPayload("sensitive-token-value");
    const bytes = Buffer.from(encrypted, "base64url");
    bytes[bytes.length - 1] ^= 0xff; // flip the last byte of the ciphertext
    const tampered = bytes.toString("base64url");

    expect(() => decryptTokenPayload(tampered)).toThrow(TokenDecryptionError);
  });

  it("rejects a garbage/too-short input instead of throwing an unhandled error", () => {
    expect(() => decryptTokenPayload("not-a-real-payload")).toThrow(TokenDecryptionError);
  });
});
