import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_LOCAL_MODEL,
  resolveAssistantProvider,
} from "./assistant-config.js";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

describe("resolveAssistantProvider", () => {
  it("is unavailable when nothing is configured", () => {
    // Never a silent default that would ship data somewhere unchosen.
    expect(resolveAssistantProvider(env({}))).toBeNull();
  });

  it("uses Anthropic when only a key is present", () => {
    const provider = resolveAssistantProvider(env({ ANTHROPIC_API_KEY: "sk-test" }));
    expect(provider).toMatchObject({
      id: "anthropic",
      model: DEFAULT_ANTHROPIC_MODEL,
      destination: "Anthropic",
      leavesMachine: true,
    });
    expect(provider?.egress.tier).toBe("public_internet");
  });

  it("uses a local model when only a base URL is present", () => {
    const provider = resolveAssistantProvider(env({ ASSISTANT_BASE_URL: DEFAULT_LOCAL_BASE_URL }));
    expect(provider).toMatchObject({ id: "openai_compatible", model: DEFAULT_LOCAL_MODEL, leavesMachine: false });
    // Measured, not assumed — see the constant's note and
    // docs/benchmarks/local-model-2026-08-14.md.
    expect(DEFAULT_LOCAL_MODEL).toBe("llama3.2:3b");
    expect(provider?.destination).toBe(DEFAULT_LOCAL_BASE_URL);
    // The tier, not a boolean, is what the disclosure reads.
    expect(provider?.egress.tier).toBe("loopback");
  });

  it("lets an explicit provider override an inferred one", () => {
    // A key present in the environment must not quietly win over an
    // operator who asked for local.
    const provider = resolveAssistantProvider(
      env({ ASSISTANT_PROVIDER: "local", ANTHROPIC_API_KEY: "sk-test", ASSISTANT_MODEL: "qwen2.5:14b" }),
    );
    expect(provider).toMatchObject({ id: "openai_compatible", model: "qwen2.5:14b", leavesMachine: false });
  });

  it("reports leavesMachine truthfully for a remote OpenAI-compatible host", () => {
    const provider = resolveAssistantProvider(
      env({ ASSISTANT_PROVIDER: "openai_compatible", ASSISTANT_BASE_URL: "https://api.deepseek.com/v1" }),
    );
    expect(provider?.leavesMachine).toBe(true);
    expect(provider?.destination).toBe("https://api.deepseek.com/v1");
    // A hostname cannot be classified without DNS, and provider resolution
    // does no I/O — so it says `unknown` rather than guessing. The status
    // route resolves it before anything is shown to the user.
    expect(provider?.egress.tier).toBe("unknown");
  });

  it("is unavailable when Anthropic is asked for without a key", () => {
    expect(resolveAssistantProvider(env({ ASSISTANT_PROVIDER: "anthropic" }))).toBeNull();
  });

  it("carries no API key for a keyless local server", () => {
    // Ollama needs none; sending an empty bearer would be noise.
    const provider = resolveAssistantProvider(env({ ASSISTANT_PROVIDER: "local" }));
    expect(provider?.apiKey).toBeNull();
    expect(provider?.baseUrl).toBe(DEFAULT_LOCAL_BASE_URL);
  });
});
