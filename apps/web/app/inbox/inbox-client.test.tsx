import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxClient } from "./inbox-client";

const push = vi.fn();
const router = { push };
const apiGet = vi.fn();
const apiPost = vi.fn();
let authState: { auth: null | { sessionToken: string }; restoring: boolean } = { auth: { sessionToken: "token" }, restoring: false };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ ...authState, setAuth: vi.fn() }) }));
vi.mock("../../lib/api", () => ({ apiGet: (...args: unknown[]) => apiGet(...args), apiPost: (...args: unknown[]) => apiPost(...args), ApiError: Error }));

beforeEach(() => {
  push.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  authState = { auth: { sessionToken: "token" }, restoring: false };
});

afterEach(cleanup);

describe("InboxClient", () => {
  it("waits for restore and redirects an unauthenticated user", async () => {
    authState = { auth: null, restoring: true };
    const { rerender } = render(<InboxClient />);
    expect(screen.getByText("Restoring your session…")).toBeInTheDocument();
    authState = { auth: null, restoring: false };
    rerender(<InboxClient />);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("offers Gmail connection when no sources exist", async () => {
    apiGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    expect(await screen.findByText("Connect Gmail to bring messages into IDent.")).toBeInTheDocument();
    apiPost.mockImplementation(() => new Promise(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
  });

  it("renders, searches, reads plain text, and preserves the list on sync failure", async () => {
    const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
    const message = { id: "message-1", subject: "Project Atlas", snippet: "Latest update", body: null, participants: null, occurredAt: "2026-08-13T10:00:00Z", isRead: false, source };
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([message]);
    render(<InboxClient />);
    expect(await screen.findByText("Project Atlas")).toBeInTheDocument();
    expect(screen.getByText("Unread")).toBeInTheDocument();
    expect(screen.getAllByText(/me@example.com/)).not.toHaveLength(0);

    apiGet.mockResolvedValueOnce([message]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "atlas" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/identity/messages?query=atlas", "token"));

    apiGet.mockResolvedValueOnce([message]);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/identity/messages", "token"));

    apiGet.mockResolvedValueOnce({ ...message, body: "<script>never executes</script>" });
    fireEvent.click(screen.getByRole("button", { name: /Project Atlas/ }));
    expect(await screen.findByText("<script>never executes</script>")).toBeInTheDocument();

    apiPost.mockRejectedValueOnce(new Error("Token revoked"));
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Token revoked");
    expect(screen.getAllByText("Project Atlas")).not.toHaveLength(0);
  });
});
