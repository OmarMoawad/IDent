import { describe, expect, it, vi } from "vitest";
import { RealGoogleCalendarWriteClient } from "./google-calendar-write-client.js";

describe("RealGoogleCalendarWriteClient", () => {
  it("patches only the self attendee to accepted", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      if (init.method === "GET") {
        return new Response(
          JSON.stringify({
            attendees: [
              { email: "other@example.com", responseStatus: "needsAction" },
              { email: "me@example.com", self: true, responseStatus: "needsAction" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = new RealGoogleCalendarWriteClient(fetchImpl);

    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({ status: "succeeded" });

    const patch = calls.find((c) => c.init.method === "PATCH");
    const body = JSON.parse(String(patch?.init.body)) as { attendees: { self?: boolean; responseStatus?: string }[] };
    // The other attendee is left exactly as it was; only self changed.
    expect(body.attendees).toEqual([
      { email: "other@example.com", responseStatus: "needsAction" },
      { email: "me@example.com", self: true, responseStatus: "accepted" },
    ]);
  });

  it("treats an already-accepted invite as an idempotent success without patching", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ attendees: [{ self: true, responseStatus: "accepted" }] }), { status: 200 }),
    );
    const client = new RealGoogleCalendarWriteClient(fetchImpl);

    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({ status: "succeeded", duplicate: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when the authenticated user is not an attendee", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ attendees: [{ email: "other@example.com" }] }), { status: 200 }),
    );
    const client = new RealGoogleCalendarWriteClient(fetchImpl);
    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({ status: "failed", code: "not_an_attendee" });
  });

  it("recovers from a patch timeout by re-reading the attendee response", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      if (init.method === "PATCH") throw new Error("timeout");
      // GET before patch: needsAction; GET after (recovery): accepted.
      const status = call >= 3 ? "accepted" : "needsAction";
      return new Response(JSON.stringify({ attendees: [{ self: true, responseStatus: status }] }), { status: 200 });
    });
    const client = new RealGoogleCalendarWriteClient(fetchImpl);

    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({ status: "succeeded" });
  });
});
