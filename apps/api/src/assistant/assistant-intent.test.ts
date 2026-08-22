import { describe, expect, it } from "vitest";
import { parseActionIntents } from "./assistant-intent.js";

describe("parseActionIntents", () => {
  it("accepts a reply draft addressed to a retrieved message reference", () => {
    expect(parseActionIntents([{ type: "reply.draft", targetRef: "message:1", body: "Thanks" }])).toEqual([
      { type: "reply.draft", targetRef: "message:1", body: "Thanks" },
    ]);
  });

  it("rejects action intents with unknown fields", () => {
    expect(() => parseActionIntents([{ type: "message.archive", targetRefs: ["message:9"], providerId: "x" }])).toThrow();
  });
});
