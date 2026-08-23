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

  it("refuses to reverse an explicit decline rather than silently accepting", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ attendees: [{ self: true, responseStatus: "declined" }] }), { status: 200 }),
    );
    const client = new RealGoogleCalendarWriteClient(fetchImpl);
    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({
      status: "failed",
      code: "response_not_reversible",
    });
    // Read only; no patch attempted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the etag as If-Match and retries once on a 412 conflict", async () => {
    let patchCalls = 0;
    const ifMatch: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") {
        // Fresh etag each read, so the retry carries the newer one.
        const etag = patchCalls === 0 ? '"v1"' : '"v2"';
        return new Response(JSON.stringify({ etag, attendees: [{ self: true, responseStatus: "needsAction" }] }), { status: 200 });
      }
      // PATCH
      ifMatch.push(new Headers(init.headers).get("if-match") ?? undefined);
      patchCalls += 1;
      return patchCalls === 1 ? new Response("conflict", { status: 412 }) : new Response("{}", { status: 200 });
    });
    const client = new RealGoogleCalendarWriteClient(fetchImpl);

    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({ status: "succeeded" });
    expect(patchCalls).toBe(2);
    // First patch used the original etag; the retry used the re-read one.
    expect(ifMatch).toEqual(['"v1"', '"v2"']);
  });

  it("reports a persistent 412 as an ambiguous concurrent modification, not a blind overwrite", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") {
        return new Response(JSON.stringify({ etag: '"v"', attendees: [{ self: true, responseStatus: "needsAction" }] }), { status: 200 });
      }
      return new Response("conflict", { status: 412 });
    });
    const client = new RealGoogleCalendarWriteClient(fetchImpl);
    expect(await client.acceptInvitation("tok", { providerEventId: "e1" })).toEqual({
      status: "outcome_unknown",
      code: "concurrent_modification",
    });
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
