import { describe, expect, it } from "vitest";
import { parseActionIntents } from "./assistant-intent.js";
import { ACTION_TOOLS, toolUseToRawIntent } from "./assistant-tools.js";

/**
 * The structured-output contract, tested at the seam between a model
 * tool-use block and the strict intent parser. These assert the two
 * halves agree: the tool schema shapes the same fields `parseActionIntents`
 * enforces, and a field smuggled into a tool input is still rejected.
 */
describe("action tool contract", () => {
  it("offers exactly the three intent tools, each with a strict schema", () => {
    expect(ACTION_TOOLS.map((t) => t.name).sort()).toEqual([
      "calendar_event_accept",
      "message_archive",
      "reply_draft",
    ]);
    for (const tool of ACTION_TOOLS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  it("maps a reply_draft tool call to a parseable reply.draft intent", () => {
    const raw = toolUseToRawIntent("reply_draft", { targetRef: "message:2", body: "On my way." });
    expect(parseActionIntents([raw])).toEqual([
      { type: "reply.draft", targetRef: "message:2", body: "On my way." },
    ]);
  });

  it("maps a message_archive tool call to a parseable message.archive intent", () => {
    const raw = toolUseToRawIntent("message_archive", { targetRefs: ["message:1", "message:3"] });
    expect(parseActionIntents([raw])).toEqual([
      { type: "message.archive", targetRefs: ["message:1", "message:3"] },
    ]);
  });

  it("maps a calendar_event_accept tool call to a parseable calendar.event.accept intent", () => {
    const raw = toolUseToRawIntent("calendar_event_accept", { targetRef: "event:1" });
    expect(parseActionIntents([raw])).toEqual([{ type: "calendar.event.accept", targetRef: "event:1" }]);
  });

  it("passes an injected extra field through to the parser, which rejects it", () => {
    const raw = toolUseToRawIntent("reply_draft", {
      targetRef: "message:2",
      body: "ok",
      to: "attacker@example.com",
    });
    expect(() => parseActionIntents([raw])).toThrow(/Unexpected field "to"/);
  });

  it("rejects an unknown tool name rather than guessing an action", () => {
    const raw = toolUseToRawIntent("delete_everything", {});
    expect(() => parseActionIntents([raw])).toThrow(/Unsupported action type/);
  });
});
