import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantClient } from "./assistant-client";

const router = { push: vi.fn() };
let authState: { auth: { sessionToken: string } | null; restoring: boolean };
const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ ...authState, setAuth: vi.fn() }) }));
vi.mock("../../lib/api", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  ApiError: Error,
}));

beforeEach(() => {
  authState = { auth: { sessionToken: "token" }, restoring: false };
  apiGet.mockReset();
  apiPost.mockReset();
  router.push.mockReset();
});
afterEach(cleanup);

describe("AssistantClient", () => {
  it("names the provider and model before any question is asked", async () => {
    // SECURITY.md commits to disclosing this up front, not in a policy page.
    apiGet.mockResolvedValueOnce({ available: true, provider: "anthropic", model: "claude-opus-5", destination: "Anthropic", leavesMachine: true });
    render(<AssistantClient />);
    expect(await screen.findByText(/sent to Anthropic \(claude-opus-5\)/)).toBeInTheDocument();
  });

  it("shows exactly what was sent to the provider with the answer", async () => {
    apiGet.mockResolvedValueOnce({ available: true, provider: "anthropic", model: "claude-opus-5", destination: "Anthropic", leavesMachine: true });
    render(<AssistantClient />);
    await screen.findByRole("button", { name: "Ask" });

    apiPost.mockResolvedValueOnce({
      answer: "The invoice total was 480 EUR.",
      refused: false,
      contextSent: { messages: 3, events: 0, contacts: 1, reminders: 0 },
    });
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "invoice total?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("The invoice total was 480 EUR.")).toBeInTheDocument();
    // The disclosure the API reports must actually reach the user — an
    // unrendered field is not a disclosure.
    expect(screen.getByText(/Sent to the provider: 3 messages, 1 contact\./)).toBeInTheDocument();
  });

  it("says so when the assistant is not configured, and disables asking", async () => {
    apiGet.mockResolvedValueOnce({ available: false, provider: null, model: null, destination: null, leavesMachine: false });
    render(<AssistantClient />);
    expect(await screen.findByText(/not configured on this server/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  it("surfaces a refusal rather than presenting it as an answer", async () => {
    apiGet.mockResolvedValueOnce({ available: true, provider: "anthropic", model: "claude-opus-5", destination: "Anthropic", leavesMachine: true });
    render(<AssistantClient />);
    await screen.findByRole("button", { name: "Ask" });

    apiPost.mockResolvedValueOnce({
      answer: "The assistant declined to answer this question.",
      refused: true,
      contextSent: { messages: 0, events: 0, contacts: 0, reminders: 0 },
    });
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "something" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText(/declined this question/)).toBeInTheDocument();
    expect(screen.getByText("No data was sent.")).toBeInTheDocument();
  });

  it("says data stays put when running locally, instead of a false third-party warning", async () => {
    // Repeating "sent to a provider" in local mode would be untrue, and
    // untrue warnings train people to ignore the true ones.
    apiGet.mockResolvedValueOnce({
      available: true,
      provider: "openai_compatible",
      model: "llama3.1:8b",
      destination: "a model running on this machine (http://localhost:11434/v1)",
      leavesMachine: false,
    });
    render(<AssistantClient />);

    expect(await screen.findByText(/do not leave this machine/)).toBeInTheDocument();
    expect(screen.queryByText(/sent to/)).not.toBeInTheDocument();
  });

  it("still warns when an OpenAI-compatible endpoint is remote", async () => {
    // The flag is derived from the URL, not the provider id — a remote
    // self-host is still egress.
    apiGet.mockResolvedValueOnce({
      available: true,
      provider: "openai_compatible",
      model: "deepseek-chat",
      destination: "https://api.deepseek.com/v1",
      leavesMachine: true,
    });
    render(<AssistantClient />);

    expect(await screen.findByText(/sent to https:\/\/api\.deepseek\.com\/v1/)).toBeInTheDocument();
  });
});
