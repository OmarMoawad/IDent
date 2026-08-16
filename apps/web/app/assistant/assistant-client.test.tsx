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

/**
 * Session 22: the disclosure is composed on the server from the egress
 * tier and rendered verbatim, so these fixtures carry the shape the API
 * actually returns rather than a hand-written sentence.
 */
const egress = (tier: string, statement: string, origin: string) => ({
  tier,
  statement,
  origin,
  reason: "test fixture",
  resolvedAddresses: [],
  caveat: "Classified at resolution time.",
});

const anthropicStatus = {
  available: true,
  provider: "anthropic",
  model: "claude-opus-5",
  destination: "Anthropic",
  egress: egress("public_internet", "Processed at https://api.anthropic.com, over the public internet.", "https://api.anthropic.com"),
  leavesMachine: true,
};

describe("AssistantClient", () => {
  it("names the provider and model before any question is asked", async () => {
    // SECURITY.md commits to disclosing this up front, not in a policy page.
    apiGet.mockResolvedValueOnce(anthropicStatus);
    render(<AssistantClient />);
    // The tier's own sentence, plus the model, both reach the user.
    expect(await screen.findByText(/over the public internet/)).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-5/)).toBeInTheDocument();
  });

  it("shows exactly what was sent to the provider with the answer", async () => {
    apiGet.mockResolvedValueOnce(anthropicStatus);
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
    apiGet.mockResolvedValueOnce({ available: false, provider: null, model: null, destination: null, egress: null, leavesMachine: false });
    render(<AssistantClient />);
    expect(await screen.findByText(/not configured on this server/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  it("surfaces a refusal rather than presenting it as an answer", async () => {
    apiGet.mockResolvedValueOnce(anthropicStatus);
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

  it("asserts where processing happens in local mode, rather than merely omitting a warning", async () => {
    // Session 22 item 4: hiding the third-party warning was right, showing
    // nothing in its place was not. An absent warning is not a checkable
    // claim, so local mode states the location positively.
    apiGet.mockResolvedValueOnce({
      available: true,
      provider: "openai_compatible",
      model: "llama3.2:3b",
      destination: "http://localhost:11434/v1",
      egress: egress(
        "loopback",
        "Processed locally at http://localhost:11434, on this machine's loopback interface. This request does not leave this machine.",
        "http://localhost:11434",
      ),
      leavesMachine: false,
    });
    render(<AssistantClient />);

    expect(await screen.findByText(/Processed locally at http:\/\/localhost:11434/)).toBeInTheDocument();
    expect(screen.getByText(/stay on this machine/)).toBeInTheDocument();
    // The false third-party sentence still must not appear.
    expect(screen.queryByText(/are sent there/)).not.toBeInTheDocument();
  });

  it("distinguishes a LAN endpoint from a hosted one, which the old boolean could not", async () => {
    // The whole reason the boolean was replaced: "not the public internet"
    // and "not off this machine" are different claims, and a LAN box is
    // the first of those but not the second.
    apiGet.mockResolvedValueOnce({
      available: true,
      provider: "openai_compatible",
      model: "llama3.2:3b",
      destination: "http://192.168.1.50:11434/v1",
      egress: egress(
        "private_network",
        "Processed at http://192.168.1.50:11434, on a private network or VPN. It leaves this machine, but not to the public internet.",
        "http://192.168.1.50:11434",
      ),
      leavesMachine: true,
    });
    render(<AssistantClient />);

    expect(await screen.findByText(/on a private network or VPN/)).toBeInTheDocument();
    expect(screen.getByText(/not to the public internet/)).toBeInTheDocument();
    expect(screen.getByText(/are sent there/)).toBeInTheDocument();
  });

  it("still warns when an OpenAI-compatible endpoint is remote", async () => {
    // The flag is derived from the URL, not the provider id — a remote
    // self-host is still egress.
    apiGet.mockResolvedValueOnce({
      available: true,
      provider: "openai_compatible",
      model: "deepseek-chat",
      destination: "https://api.deepseek.com/v1",
      egress: egress(
        "public_internet",
        "Processed at https://api.deepseek.com, over the public internet.",
        "https://api.deepseek.com",
      ),
      leavesMachine: true,
    });
    render(<AssistantClient />);

    expect(await screen.findByText(/Processed at https:\/\/api\.deepseek\.com/)).toBeInTheDocument();
    expect(screen.getByText(/are sent there/)).toBeInTheDocument();
  });
});
