import { describe, expect, it } from "vitest";
import { generateRecoveryCode, normalizeRecoveryCode } from "./recovery-code.js";

describe("generateRecoveryCode", () => {
  it("produces a hyphenated, uppercase, fixed-length code", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it("never repeats across calls", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(50);
  });
});

describe("normalizeRecoveryCode", () => {
  it("strips hyphens, trims whitespace, and upcases", () => {
    expect(normalizeRecoveryCode(" abcd-efgh ")).toBe("ABCDEFGH");
  });
});
