import { describe, expect, it, vi } from "vitest";
import { requestedScopes } from "./comms-config.js";
import { RealGoogleMailWriteClient, buildReplyMime, draftMessageId } from "./google-mail-write-client.js";

function decodeRaw(base64url: string): string {
  return Buffer.from(base64url, "base64url").toString("utf8");
}

describe("requested OAuth scopes", () => {
  it("include the narrow Gmail and Calendar write scopes", () => {
    expect(requestedScopes()).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(requestedScopes()).toContain("https://www.googleapis.com/auth/calendar.events");
  });
});

describe("reply draft MIME", () => {
  it("carries a deterministic Message-ID derived from the operation key", () => {
    const raw = decodeRaw(buildReplyMime({ to: "jane@example.com", subject: "Re: Hi", body: "Thanks", operationKey: "op-1" }));
    expect(raw).toContain("Message-ID:");
    expect(raw).toContain(draftMessageId("op-1"));
    expect(raw).toContain("To: jane@example.com");
    // Same operation key always yields the same Message-ID — the recovery anchor.
    expect(draftMessageId("op-1")).toBe(draftMessageId("op-1"));
  });
});

describe("RealGoogleMailWriteClient", () => {
  it("creates a draft and returns the provider id", async () => {
    let sentBody = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ id: "draft-1" }), { status: 200 });
    });
    const client = new RealGoogleMailWriteClient(fetchImpl);

    const outcome = await client.createReplyDraft("tok", {
      to: "jane@example.com",
      subject: "Re: Hi",
      body: "Thanks",
      operationKey: "op-9",
    });

    expect(outcome).toEqual({ status: "succeeded", providerId: "draft-1" });
    const parsed = JSON.parse(sentBody) as { message: { raw: string } };
    expect(decodeRaw(parsed.message.raw)).toContain(draftMessageId("op-9"));
  });

  it("treats an already-archived message as an idempotent success", async () => {
    // The GET returns labels without INBOX, so no modify call is needed.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ labelIds: ["CATEGORY_PERSONAL"] }), { status: 200 }));
    const client = new RealGoogleMailWriteClient(fetchImpl);

    expect(await client.archiveMessage("tok", "m1")).toEqual({ status: "succeeded", duplicate: true });
    // Only the state fetch happened; nothing was mutated.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("removes only the INBOX label when a message is still in the inbox", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "GET") return new Response(JSON.stringify({ labelIds: ["INBOX"] }), { status: 200 });
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const client = new RealGoogleMailWriteClient(fetchImpl);

    expect(await client.archiveMessage("tok", "m1")).toEqual({ status: "succeeded" });
    const modify = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(modify?.init.body))).toEqual({ removeLabelIds: ["INBOX"] });
  });

  it("recovers from a create timeout by finding the draft's Message-ID", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("network timeout");
      // The recovery search finds the draft that was in fact created.
      return new Response(JSON.stringify({ messages: [{ id: "draft-x" }] }), { status: 200 });
    });
    const client = new RealGoogleMailWriteClient(fetchImpl);

    expect(await client.createReplyDraft("tok", { to: "j@x.com", subject: "s", body: "b", operationKey: "op" })).toEqual({
      status: "succeeded",
      providerId: "draft-x",
      duplicate: true,
    });
  });

  it("maps an unauthorized response to a safe failure code", async () => {
    const client = new RealGoogleMailWriteClient(vi.fn(async () => new Response("no", { status: 403 })));
    expect(await client.archiveMessage("tok", "m1")).toEqual({ status: "failed", code: "unauthorized" });
  });
});
