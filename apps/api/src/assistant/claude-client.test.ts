import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AssistantProvider } from "./assistant-config.js";
import { AnthropicAssistantClient } from "./claude-client.js";

/**
 * Phase 3 (write-action gate 2). The offline half of the structured-output
 * contract: feed the *real* client a canned Anthropic response — including
 * genuine `tool_use` blocks — through its `create` seam and assert the
 * client turns them into strictly-parsed action intents. This closes the
 * gap the earlier design left open, where intents only ever reached the
 * proposal path through a fake client swapped in for the Anthropic one.
 *
 * The live half — that the model actually emits such a tool call against
 * the hosted API — is assistant-live.test.ts, gated on a configured
 * provider, plus the `verify:live` artifact. Both need Omar's key/account.
 */

const provider: AssistantProvider = {
  id: "anthropic",
  model: "claude-opus-5",
  baseUrl: null,
  apiKey: "test-key",
  destination: "Anthropic",
  egress: { tier: "public", leavesMachine: true, label: "Anthropic's hosted API." } as never,
  leavesMachine: true,
};

function message(content: Anthropic.ContentBlock[], stopReason: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
  } as Anthropic.Message;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: [] } as unknown as Anthropic.ContentBlock;
}

function toolUseBlock(name: string, input: unknown): Anthropic.ContentBlock {
  return { type: "tool_use", id: "toolu_1", name, input } as unknown as Anthropic.ContentBlock;
}

describe("AnthropicAssistantClient structured output", () => {
  it("offers the action tools and the composed system prompt on every request", async () => {
    const create = vi.fn().mockResolvedValue(message([textBlock("Here is your answer.")]));
    const client = new AnthropicAssistantClient(provider, create);
    await client.ask({ question: "what's up?", context: "[message 1] hi" });

    const params = create.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.tools?.map((t) => t.name).sort()).toEqual([
      "calendar_event_accept",
      "message_archive",
      "reply_draft",
    ]);
    expect(String(params.system)).toMatch(/PROPOSE an action/);
  });

  it("returns no action intents for an answer-only response", async () => {
    const create = vi.fn().mockResolvedValue(message([textBlock("It's on Tuesday.")]));
    const answer = await new AnthropicAssistantClient(provider, create).ask({ question: "when?", context: "ctx" });
    expect(answer.actionIntents).toEqual([]);
    expect(answer.text).toBe("It's on Tuesday.");
  });

  it("parses a tool_use block into a strict action intent", async () => {
    const create = vi.fn().mockResolvedValue(
      message([
        textBlock("Drafted a reply."),
        toolUseBlock("reply_draft", { targetRef: "message:2", body: "Sounds good, see you then." }),
      ]),
    );
    const answer = await new AnthropicAssistantClient(provider, create).ask({
      question: "reply saying yes",
      context: "[message 2] Are you coming?",
    });
    expect(answer.actionIntents).toEqual([
      { type: "reply.draft", targetRef: "message:2", body: "Sounds good, see you then." },
    ]);
    expect(answer.text).toBe("Drafted a reply.");
  });

  it("rejects a tool_use input that smuggles an extra field", async () => {
    const create = vi.fn().mockResolvedValue(
      message([toolUseBlock("reply_draft", { targetRef: "message:2", body: "ok", to: "attacker@example.com" })]),
    );
    await expect(
      new AnthropicAssistantClient(provider, create).ask({ question: "reply", context: "ctx" }),
    ).rejects.toThrow(/Unexpected field "to"/);
  });

  it("treats a refusal stop reason as a refusal with no intents", async () => {
    const create = vi.fn().mockResolvedValue(message([], "refusal"));
    const answer = await new AnthropicAssistantClient(provider, create).ask({ question: "x", context: "ctx" });
    expect(answer.refused).toBe(true);
    expect(answer.actionIntents).toEqual([]);
  });
});
