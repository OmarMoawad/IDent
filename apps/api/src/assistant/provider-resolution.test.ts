import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_LOCAL_MODEL,
  isLoopbackUrl,
  resolveAssistantProvider,
} from "./assistant-config.js";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

describe("isLoopbackUrl", () => {
  it("recognises the loopback forms", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://[::1]:11434/v1"]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  it("treats a LAN address as off-machine", () => {
    // "not the public internet" is not the same claim as "not off this
    // machine", and the disclosure must not blur the two.
    expect(isLoopbackUrl("http://192.168.1.50:11434/v1")).toBe(false);
    expect(isLoopbackUrl("https://api.example.com/v1")).toBe(false);
    expect(isLoopbackUrl("not-a-url")).toBe(false);
  });
});

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
  });

  it("uses a local model when only a base URL is present", () => {
    const provider = resolveAssistantProvider(env({ ASSISTANT_BASE_URL: DEFAULT_LOCAL_BASE_URL }));
    expect(provider).toMatchObject({ id: "openai_compatible", model: DEFAULT_LOCAL_MODEL, leavesMachine: false });
    expect(provider?.destination).toContain("this machine");
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
