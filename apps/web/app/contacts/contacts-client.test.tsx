import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactsClient } from "./contacts-client";

const push = vi.fn();
const router = { push };
const apiGet = vi.fn();
const apiPost = vi.fn();
let authState: { auth: null | { sessionToken: string }; restoring: boolean } = { auth: { sessionToken: "token" }, restoring: false };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ ...authState, setAuth: vi.fn() }) }));
vi.mock("../../lib/api", () => ({ apiGet: (...args: unknown[]) => apiGet(...args), apiPost: (...args: unknown[]) => apiPost(...args), ApiError: Error }));

const jane = {
  id: "contact-1",
  address: "jane@example.com",
  displayName: "Jane Doe",
  messageCount: 3,
  firstSeenAt: "2026-08-01T10:00:00Z",
  lastSeenAt: "2026-08-13T10:00:00Z",
};

beforeEach(() => {
  push.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  authState = { auth: { sessionToken: "token" }, restoring: false };
});

afterEach(cleanup);

describe("ContactsClient", () => {
  it("waits for restore and redirects an unauthenticated user", async () => {
    authState = { auth: null, restoring: true };
    const { rerender } = render(<ContactsClient />);
    expect(screen.getByText("Restoring your session…")).toBeInTheDocument();
    authState = { auth: null, restoring: false };
    rerender(<ContactsClient />);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("explains the empty state instead of showing a blank page", async () => {
    apiGet.mockResolvedValueOnce([]);
    render(<ContactsClient />);
    expect(await screen.findByText(/No contacts yet/)).toBeInTheDocument();
  });

  it("renders one card per person with name, address, and message count", async () => {
    apiGet.mockResolvedValueOnce([jane]);
    render(<ContactsClient />);
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByText(/3 messages/)).toBeInTheDocument();
  });

  it("singularizes a one-message contact", async () => {
    apiGet.mockResolvedValueOnce([{ ...jane, messageCount: 1 }]);
    render(<ContactsClient />);
    expect(await screen.findByText(/1 message ·/)).toBeInTheDocument();
  });

  it("falls back to the address when a contact has no display name", async () => {
    apiGet.mockResolvedValueOnce([{ ...jane, displayName: null }]);
    render(<ContactsClient />);
    expect(await screen.findByRole("button", { name: /jane@example.com/ })).toBeInTheDocument();
  });

  it("searches and clears, keeping the query in the request", async () => {
    apiGet.mockResolvedValueOnce([jane]);
    render(<ContactsClient />);
    await screen.findByText("Jane Doe");

    apiGet.mockResolvedValueOnce([jane]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jane" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/identity/contacts?query=jane", "token"));

    apiGet.mockResolvedValueOnce([jane]);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/identity/contacts", "token"));
  });

  it("opens a contact and lists their recent messages", async () => {
    apiGet.mockResolvedValueOnce([jane]);
    render(<ContactsClient />);
    await screen.findByText("Jane Doe");

    apiGet.mockResolvedValueOnce({
      ...jane,
      messages: [{ id: "m1", subject: "Lunch Friday", snippet: null, occurredAt: "2026-08-13T10:00:00Z", isRead: false }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Jane Doe/ }));
    expect(await screen.findByText("Lunch Friday")).toBeInTheDocument();
  });

  it("surfaces a rebuild failure without clearing the existing cards", async () => {
    apiGet.mockResolvedValueOnce([jane]);
    render(<ContactsClient />);
    await screen.findByText("Jane Doe");

    apiPost.mockRejectedValueOnce(new Error("Rebuild failed"));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild from messages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Rebuild failed");
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });

  it("reports how many contacts a successful rebuild produced", async () => {
    apiGet.mockResolvedValueOnce([jane]);
    render(<ContactsClient />);
    await screen.findByText("Jane Doe");

    apiPost.mockResolvedValueOnce({ contactCount: 1, messagesScanned: 4 });
    apiGet.mockResolvedValueOnce([jane]);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild from messages" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Rebuilt from 4 messages: 1 contact.");
  });
});
