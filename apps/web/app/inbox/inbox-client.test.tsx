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
    apiGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    expect(await screen.findByText("Connect Gmail to bring messages into IDent.")).toBeInTheDocument();
    apiPost.mockImplementation(() => new Promise(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
  });

  it("says so when contacts could not be refreshed after an otherwise good sync", async () => {
    const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    await screen.findByRole("button", { name: "Sync now" });

    apiPost
      .mockResolvedValueOnce({ messagesSeen: 3, messagesUpserted: 3 }) // sync succeeds
      .mockRejectedValueOnce(new Error("rebuild exploded")); // contacts rebuild fails
    apiGet.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Sync complete: 3 seen, 3 saved.");
    expect(status).toHaveTextContent("Contacts could not be refreshed");
    // The sync itself is still reported as successful, not as an error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a plain success when both sync and the contact refresh work", async () => {
    const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    await screen.findByRole("button", { name: "Sync now" });

    apiPost.mockResolvedValueOnce({ messagesSeen: 2, messagesUpserted: 2 }).mockResolvedValueOnce({ contactCount: 1 });
    apiGet.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Sync complete: 2 seen, 2 saved.");
    expect(status).not.toHaveTextContent("could not be refreshed");
  });

  it("names the sender from the {from,to} envelope the sync actually writes", async () => {
    // Regression: session 16 parsed this column as a flat array, so every
    // real synced message rendered as "Unknown sender". This fixture is
    // deliberately the exact shape gmail-sync-service.ts writes.
    const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
    const participants = JSON.stringify({
      from: [{ name: "Jane Doe", address: "jane@example.com" }],
      to: [{ address: "me@example.com" }],
    });
    const message = { id: "message-1", subject: "Project Atlas", snippet: "Latest update", body: null, participants, occurredAt: "2026-08-13T10:00:00Z", isRead: false, source };
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([message]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    expect(screen.queryByText("Unknown sender")).not.toBeInTheDocument();
  });

  it("still says Unknown sender when a message genuinely has no usable participants", async () => {
    const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
    const message = { id: "message-1", subject: "Project Atlas", snippet: null, body: null, participants: "not json", occurredAt: "2026-08-13T10:00:00Z", isRead: false, source };
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([message]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    expect(await screen.findByText("Unknown sender")).toBeInTheDocument();
  });

  it("renders, searches, reads plain text, and preserves the list on sync failure", async () => {
    const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
    const message = { id: "message-1", subject: "Project Atlas", snippet: "Latest update", body: null, participants: null, occurredAt: "2026-08-13T10:00:00Z", isRead: false, source };
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([message]).mockResolvedValueOnce([]);
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

describe("importance controls (session 19)", () => {
  const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
  const message = {
    id: "m1",
    subject: "Newsletter",
    snippet: "unsubscribe",
    body: null,
    isRead: true,
    occurredAt: "2026-08-01T10:00:00.000Z",
    participants: JSON.stringify({ from: [{ address: "digest@example.com" }], to: [] }),
    source,
  };

  it("shows the priority and its reason without hiding the message", async () => {
    apiGet
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([message])
      .mockResolvedValueOnce([
        { messageId: "m1", level: "low", reason: "Looks like bulk mail.", assignedBy: "assistant" },
      ]);
    render(<InboxClient />);

    // The label is visible AND the message is still listed — the whole
    // point of a negotiated filter rather than a silent one.
    expect(await screen.findByText(/Priority: low — Looks like bulk mail\./)).toBeInTheDocument();
    expect(screen.getByText("Newsletter")).toBeInTheDocument();
  });

  it("exposes a way to run the review from the UI", async () => {
    // Regression: the classify action existed in code but no button
    // rendered it, so the feature was unreachable and every other
    // priority test still passed. Assert the entry point, not just the
    // behaviour behind it.
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce([message]).mockResolvedValueOnce([]);
    render(<InboxClient />);
    const review = await screen.findByRole("button", { name: "Review priorities" });

    apiPost.mockResolvedValueOnce({ classified: 1 });
    apiGet.mockResolvedValueOnce([]);
    fireEvent.click(review);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/identity/priorities/classify", {}, "token"),
    );
    // And it says plainly that nothing was hidden.
    expect(await screen.findByRole("status")).toHaveTextContent(/Nothing was hidden/);
  });

  it("lets the user override one call", async () => {
    apiGet
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([message])
      .mockResolvedValueOnce([
        { messageId: "m1", level: "low", reason: "Looks like bulk mail.", assignedBy: "assistant" },
      ]);
    render(<InboxClient />);
    await screen.findByText("Newsletter");

    apiGet.mockResolvedValueOnce(message);
    fireEvent.click(screen.getByRole("button", { name: /Newsletter/ }));
    const markHigh = await screen.findByRole("button", { name: "Mark high" });

    apiPost.mockResolvedValueOnce({});
    apiGet.mockResolvedValueOnce([
      { messageId: "m1", level: "high", reason: "You set this priority yourself.", assignedBy: "user" },
    ]);
    fireEvent.click(markHigh);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/identity/priorities/m1", { level: "high" }, "token"),
    );
  });

  it("lets the user change the rule behind the call, not just the one message", async () => {
    apiGet
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([message])
      .mockResolvedValueOnce([
        { messageId: "m1", level: "low", reason: "Looks like bulk mail.", assignedBy: "assistant" },
      ]);
    render(<InboxClient />);
    await screen.findByText("Newsletter");

    apiGet.mockResolvedValueOnce(message);
    fireEvent.click(screen.getByRole("button", { name: /Newsletter/ }));
    const always = await screen.findByRole("button", { name: "Always prioritize this sender" });

    apiPost.mockResolvedValue({});
    apiGet.mockResolvedValue([]);
    fireEvent.click(always);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        "/identity/priority-rules",
        { matchType: "contact", matchValue: "digest@example.com", level: "high" },
        "token",
      ),
    );
  });
});

describe("notifications in the unified inbox (session 20)", () => {
  const source = { id: "source-1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" };
  const mail = {
    id: "m1",
    subject: "Lunch Friday?",
    snippet: "still on?",
    body: null,
    isRead: true,
    kind: "message",
    actionUrl: null,
    occurredAt: "2026-08-01T10:00:00.000Z",
    participants: JSON.stringify({ from: [{ address: "jane@example.com" }], to: [] }),
    source,
  };
  const notification = {
    id: "n1",
    subject: "Review requested",
    snippet: "on PR #12",
    body: "on PR #12",
    isRead: false,
    kind: "notification",
    actionUrl: "https://github.example/pr/12",
    occurredAt: "2026-08-02T10:00:00.000Z",
    participants: JSON.stringify({ from: [{ name: "GitHub", address: "github@notifications.ident" }], to: [] }),
    source,
  };

  function load(messages: unknown[]) {
    apiGet.mockResolvedValueOnce([source]).mockResolvedValueOnce(messages).mockResolvedValueOnce([]);
  }

  it("lists mail and notifications together by default", async () => {
    // Phase 1's first bullet is a single unified inbox, not two lists.
    load([notification, mail]);
    render(<InboxClient />);

    expect(await screen.findByText("Review requested")).toBeInTheDocument();
    expect(screen.getByText("Lunch Friday?")).toBeInTheDocument();
    expect(screen.getByText("Notification")).toBeInTheDocument();
  });

  it("can narrow to one kind and back to both", async () => {
    load([notification, mail]);
    render(<InboxClient />);
    await screen.findByText("Review requested");

    apiGet.mockResolvedValueOnce([notification]);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith("/identity/messages?kind=notification", "token"),
    );

    apiGet.mockResolvedValueOnce([notification, mail]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    // No kind param — "All" must not be a third filter value.
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/identity/messages", "token"));
  });

  it("renders the action link for a notification that has one", async () => {
    load([notification]);
    render(<InboxClient />);
    await screen.findByText("Review requested");

    apiGet.mockResolvedValueOnce(notification);
    fireEvent.click(screen.getByRole("button", { name: /Review requested/ }));

    const link = await screen.findByRole("link", { name: /Open in GitHub/ });
    expect(link).toHaveAttribute("href", "https://github.example/pr/12");
    // Opening an untrusted third-party URL must not hand it window.opener.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("reveals the ingest endpoint on request rather than showing it by default", async () => {
    load([]);
    render(<InboxClient />);
    const button = await screen.findByRole("button", { name: "Show ingest endpoint" });
    // The token is a credential, so it isn't rendered until asked for.
    expect(screen.queryByText(/notifications\/ingest/)).not.toBeInTheDocument();

    apiGet.mockResolvedValueOnce({ path: "/notifications/ingest/abc123" });
    fireEvent.click(button);
    expect(await screen.findByText(/\/notifications\/ingest\/abc123/)).toBeInTheDocument();
  });
});
