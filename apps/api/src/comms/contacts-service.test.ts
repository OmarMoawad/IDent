import { describe, expect, it } from "vitest";
import { deriveContacts } from "./contacts-service.js";

function message(participants: unknown, occurredAt: string) {
  return {
    participants: participants === null ? null : JSON.stringify(participants),
    occurredAt: new Date(occurredAt),
  };
}

describe("deriveContacts", () => {
  it("produces one record per person across many messages", () => {
    const derived = deriveContacts([
      message({ from: [{ name: "Jane Doe", address: "jane@example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [{ name: "Jane Doe", address: "jane@example.com" }], to: [] }, "2026-08-03T10:00:00Z"),
      message({ from: [{ address: "bob@example.com" }], to: [] }, "2026-08-02T10:00:00Z"),
    ]);

    expect(derived).toHaveLength(2);
    expect(derived[0]).toMatchObject({ address: "jane@example.com", displayName: "Jane Doe", messageCount: 2 });
    expect(derived[1]).toMatchObject({ address: "bob@example.com", displayName: null, messageCount: 1 });
  });

  it("treats addresses case-insensitively as the same person", () => {
    const derived = deriveContacts([
      message({ from: [{ address: "Jane@Example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [{ address: "jane@example.com" }], to: [] }, "2026-08-02T10:00:00Z"),
    ]);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ address: "jane@example.com", messageCount: 2 });
  });

  it("unifies a person across sender and recipient roles", () => {
    const derived = deriveContacts([
      message({ from: [{ address: "jane@example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [], to: [{ address: "jane@example.com" }] }, "2026-08-02T10:00:00Z"),
    ]);
    expect(derived).toHaveLength(1);
    expect(derived[0].messageCount).toBe(2);
  });

  it("counts one interaction when a person is both sender and recipient of a message", () => {
    const derived = deriveContacts([
      message({ from: [{ address: "jane@example.com" }], to: [{ address: "jane@example.com" }] }, "2026-08-01T10:00:00Z"),
    ]);
    expect(derived[0].messageCount).toBe(1);
  });

  it("tracks the real first and last interaction regardless of input order", () => {
    const derived = deriveContacts([
      message({ from: [{ address: "jane@example.com" }], to: [] }, "2026-08-05T10:00:00Z"),
      message({ from: [{ address: "jane@example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [{ address: "jane@example.com" }], to: [] }, "2026-08-03T10:00:00Z"),
    ]);
    expect(derived[0].firstSeenAt.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(derived[0].lastSeenAt.toISOString()).toBe("2026-08-05T10:00:00.000Z");
  });

  it("prefers the most recently seen display name", () => {
    const derived = deriveContacts([
      message({ from: [{ name: "J. Doe", address: "jane@example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [{ name: "Jane Doe", address: "jane@example.com" }], to: [] }, "2026-08-09T10:00:00Z"),
    ]);
    expect(derived[0].displayName).toBe("Jane Doe");
  });

  it("keeps a known name when a later message carries none", () => {
    const derived = deriveContacts([
      message({ from: [{ name: "Jane Doe", address: "jane@example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [{ address: "jane@example.com" }], to: [] }, "2026-08-09T10:00:00Z"),
    ]);
    expect(derived[0].displayName).toBe("Jane Doe");
  });

  it("excludes the identity's own mailbox addresses", () => {
    const derived = deriveContacts(
      [message({ from: [{ address: "me@example.com" }], to: [{ address: "jane@example.com" }] }, "2026-08-01T10:00:00Z")],
      new Set(["me@example.com"]),
    );
    expect(derived.map((contact) => contact.address)).toEqual(["jane@example.com"]);
  });

  it("orders most recently seen first", () => {
    const derived = deriveContacts([
      message({ from: [{ address: "old@example.com" }], to: [] }, "2026-01-01T10:00:00Z"),
      message({ from: [{ address: "recent@example.com" }], to: [] }, "2026-08-01T10:00:00Z"),
    ]);
    expect(derived.map((contact) => contact.address)).toEqual(["recent@example.com", "old@example.com"]);
  });

  it("survives malformed, empty, and legacy-shaped participant data", () => {
    const derived = deriveContacts([
      message(null, "2026-08-01T10:00:00Z"),
      { participants: "not json at all", occurredAt: new Date("2026-08-01T10:00:00Z") },
      message({ from: [{ address: "   " }], to: [] }, "2026-08-01T10:00:00Z"),
      message({ from: [{ notAnAddress: true }], to: [] }, "2026-08-01T10:00:00Z"),
      // The bare-array shape the column could hold from an older writer.
      message([{ name: "Legacy", address: "legacy@example.com" }], "2026-08-02T10:00:00Z"),
    ]);
    expect(derived).toEqual([
      expect.objectContaining({ address: "legacy@example.com", displayName: "Legacy", messageCount: 1 }),
    ]);
  });
});
