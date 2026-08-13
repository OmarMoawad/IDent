import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarClient } from "./calendar-client";

const router = { push: vi.fn() };
let authState: { auth: { sessionToken: string } | null; restoring: boolean };
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ ...authState, setAuth: vi.fn() }) }));
vi.mock("../../lib/api", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
  ApiError: Error,
}));

function loadWith(events: unknown[], reminders: unknown[], sources: unknown[] = []) {
  apiGet.mockResolvedValueOnce(events).mockResolvedValueOnce(reminders).mockResolvedValueOnce(sources);
}

beforeEach(() => {
  authState = { auth: { sessionToken: "token" }, restoring: false };
  apiGet.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
});
afterEach(cleanup);

describe("CalendarClient", () => {
  it("renders an all-day event as a day, not a time", async () => {
    loadWith(
      [{ id: "e1", title: "Holiday", location: null, startsAt: "2026-08-20T00:00:00.000Z", isAllDay: true }],
      [],
    );
    render(<CalendarClient />);
    expect(await screen.findByText(/\(all day\)/)).toBeInTheDocument();
  });

  it("lets a user create a reminder", async () => {
    loadWith([], []);
    render(<CalendarClient />);
    await screen.findByLabelText("Add a reminder");

    apiPost.mockResolvedValueOnce({});
    loadWith([], [{ id: "r1", title: "Renew passport", notes: null, dueAt: null, completedAt: null }]);
    fireEvent.change(screen.getByLabelText("Add a reminder"), { target: { value: "Renew passport" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Renew passport")).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith("/identity/reminders", { title: "Renew passport", dueAt: undefined }, "token");
  });

  it("surfaces the reconnect prompt when the grant predates calendar scope", async () => {
    loadWith([], [], [{ id: "s1", provider: "gmail", status: "connected", providerAccountEmail: "me@example.com" }]);
    render(<CalendarClient />);
    const sync = await screen.findByRole("button", { name: "Sync calendar" });

    apiPost.mockRejectedValueOnce(new Error("This connection predates calendar access. Reconnect Google to grant it."));
    fireEvent.click(sync);
    expect(await screen.findByRole("alert")).toHaveTextContent(/predates calendar access/);
  });
});
