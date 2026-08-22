import { describe, expect, it } from "vitest";
import { canonicalize, digestCanonical, NonCanonicalizableError } from "./canonical-json.js";

describe("canonicalize", () => {
  it("orders object keys so the same payload always serialises the same way", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("orders keys recursively but preserves array order", () => {
    expect(canonicalize({ z: [{ y: 1, x: 2 }], a: "t" })).toBe('{"a":"t","z":[{"x":2,"y":1}]}');
    // Arrays are sequences: their order is meaningful and must be kept.
    expect(canonicalize(["message:2", "message:1"])).toBe('["message:2","message:1"]');
  });

  it("rejects values JSON.stringify would silently corrupt", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(NonCanonicalizableError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(NonCanonicalizableError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => canonicalize({ a: undefined } as any)).toThrow(NonCanonicalizableError);
  });

  it("produces a stable SHA-256 digest independent of key order", () => {
    const digest = digestCanonical({ type: "reply.draft", to: "x", body: "hi" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestCanonical({ body: "hi", to: "x", type: "reply.draft" })).toBe(digest);
  });
});
