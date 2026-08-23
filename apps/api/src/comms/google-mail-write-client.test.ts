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
  const base = { to: "jane@example.com", subject: "Re: Hi", body: "Thanks", inReplyToProviderMessageId: "orig-1", operationKey: "op-1" };

  it("carries a deterministic Message-ID derived from the operation key", () => {
    const raw = decodeRaw(buildReplyMime(base));
    expect(raw).toContain("Message-ID:");
    expect(raw).toContain(draftMessageId("op-1"));
    expect(raw).toContain("To: jane@example.com");
    // Same operation key always yields the same Message-ID — the recovery anchor.
    expect(draftMessageId("op-1")).toBe(draftMessageId("op-1"));
  });

  it("emits In-Reply-To and References when the original Message-ID is known", () => {
    const raw = decodeRaw(buildReplyMime(base, { inReplyTo: "<orig@mail.gmail.com>" }));
    expect(raw).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(raw).toContain("References: <orig@mail.gmail.com>");
  });

  it("omits threading headers when there is no original Message-ID", () => {
    const raw = decodeRaw(buildReplyMime(base));
    expect(raw).not.toContain("In-Reply-To:");
  });
});

// Routes a fake Gmail fetch by URL/method so createReplyDraft's metadata
// read, draft POST, and recovery search can each be exercised.
function gmailFake(handlers: {
  metadata?: () => Response;
  createDraft?: (init: RequestInit) => Response;
  search?: () => Response;
}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("format=metadata")) return handlers.metadata?.() ?? new Response("{}", { status: 200 });
    if (url.endsWith("/drafts")) return handlers.createDraft?.(init) ?? new Response(JSON.stringify({ id: "d" }), { status: 200 });
    if (url.includes("/messages?q=")) return handlers.search?.() ?? new Response(JSON.stringify({ messages: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

describe("RealGoogleMailWriteClient", () => {
  it("threads the draft into the original conversation", async () => {
    let sentBody = "";
    const fetchImpl = gmailFake({
      metadata: () =>
        new Response(
          JSON.stringify({ threadId: "thread-42", payload: { headers: [{ name: "Message-ID", value: "<orig@x>" }] } }),
          { status: 200 },
        ),
      createDraft: (init) => {
        sentBody = String(init.body);
        return new Response(JSON.stringify({ id: "draft-1" }), { status: 200 });
      },
    });
    const client = new RealGoogleMailWriteClient(fetchImpl);

    const outcome = await client.createReplyDraft("tok", {
      to: "jane@example.com",
      subject: "Re: Hi",
      body: "Thanks",
      inReplyToProviderMessageId: "orig-1",
      operationKey: "op-9",
    });

    expect(outcome).toEqual({ status: "succeeded", providerId: "draft-1" });
    const parsed = JSON.parse(sentBody) as { message: { raw: string; threadId?: string } };
    // The draft sits in the original thread and references the original message.
    expect(parsed.message.threadId).toBe("thread-42");
    const raw = decodeRaw(parsed.message.raw);
    expect(raw).toContain(draftMessageId("op-9"));
    expect(raw).toContain("In-Reply-To: <orig@x>");
  });

  it("still creates the draft (unthreaded) when the original can't be read", async () => {
    let sentBody = "";
    const fetchImpl = gmailFake({
      metadata: () => new Response("nope", { status: 404 }),
      createDraft: (init) => {
        sentBody = String(init.body);
        return new Response(JSON.stringify({ id: "draft-2" }), { status: 200 });
      },
    });
    const client = new RealGoogleMailWriteClient(fetchImpl);

    const outcome = await client.createReplyDraft("tok", {
      to: "j@x.com", subject: "Re: s", body: "b", inReplyToProviderMessageId: "orig-x", operationKey: "op",
    });
    expect(outcome).toEqual({ status: "succeeded", providerId: "draft-2" });
    const parsed = JSON.parse(sentBody) as { message: { raw: string; threadId?: string } };
    expect(parsed.message.threadId).toBeUndefined();
    expect(decodeRaw(parsed.message.raw)).not.toContain("In-Reply-To:");
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
    const fetchImpl = gmailFake({
      metadata: () => new Response(JSON.stringify({ threadId: "t" }), { status: 200 }),
      createDraft: () => {
        throw new Error("network timeout");
      },
      // The recovery search finds the draft that was in fact created.
      search: () => new Response(JSON.stringify({ messages: [{ id: "draft-x" }] }), { status: 200 }),
    });
    const client = new RealGoogleMailWriteClient(fetchImpl);

    expect(
      await client.createReplyDraft("tok", { to: "j@x.com", subject: "s", body: "b", inReplyToProviderMessageId: "o", operationKey: "op" }),
    ).toEqual({ status: "succeeded", providerId: "draft-x", duplicate: true });
  });

  it("maps an unauthorized response to a safe failure code", async () => {
    const client = new RealGoogleMailWriteClient(vi.fn(async () => new Response("no", { status: 403 })));
    expect(await client.archiveMessage("tok", "m1")).toEqual({ status: "failed", code: "unauthorized" });
  });
});
