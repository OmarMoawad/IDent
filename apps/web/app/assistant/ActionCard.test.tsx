import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionCard, type PendingAction } from "./ActionCard";

const apiPost = vi.fn();
vi.mock("../../lib/api", () => ({
  apiPost: (...args: unknown[]) => apiPost(...args),
  ApiError: Error,
}));

beforeEach(() => apiPost.mockReset());
afterEach(cleanup);

const draft: PendingAction = {
  id: "a1",
  actionType: "reply.draft",
  payloadDigest: "digest-1",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  summary: { kind: "reply.draft", to: "jane@example.com", subject: "Re: Invoice", body: "Thanks!" },
};

describe("ActionCard", () => {
  it("shows the server-built preview and requires an explicit confirm then run", async () => {
    apiPost.mockResolvedValueOnce({ status: "approved" });
    render(<ActionCard action={draft} token="tok" />);

    // The preview is the server's, including the recipient it derived.
    expect(screen.getByText(/To: jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/A draft only — nothing is sent/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(screen.getByText(/Approved/i)).toBeInTheDocument());
    // The digest the server built is what is echoed back on confirm.
    expect(apiPost).toHaveBeenCalledWith(
      "/identity/assistant/actions/a1/confirm",
      { payloadDigest: "digest-1" },
      "tok",
    );
    // A separate Run control appears only after approval.
    expect(screen.getByRole("button", { name: /run it/i })).toBeInTheDocument();
  });

  it("prompts a reconnect when execution fails for a missing grant", async () => {
    apiPost.mockResolvedValueOnce({ status: "approved" });
    apiPost.mockResolvedValueOnce({ status: "failed", outcomeCode: "ineligible:missing_scope" });
    render(<ActionCard action={draft} token="tok" />);

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => screen.getByRole("button", { name: /run it/i }));
    fireEvent.click(screen.getByRole("button", { name: /run it/i }));

    await waitFor(() => expect(screen.getByText(/Failed/i)).toBeInTheDocument());
    expect(screen.getByText(/not authorised to make changes/i)).toBeInTheDocument();
    // No further action controls in a terminal state.
    expect(screen.queryByRole("button", { name: /run it/i })).not.toBeInTheDocument();
  });
});
