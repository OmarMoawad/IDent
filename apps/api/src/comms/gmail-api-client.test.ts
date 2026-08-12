import { describe, expect, it } from "vitest";
import { toGmailMessage, type GmailMessageResource } from "./gmail-api-client.js";

// Only toGmailMessage is pure (no network) — listMessageIds and getMessage
// both call Gmail's real endpoints and are exercised indirectly instead,
// through gmail-sync-service.test.ts's FakeGmailApiClient double. Same
// convention google-oauth-client.test.ts already documents for
// RealGoogleOAuthClient.getAuthorizationUrl.
function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

describe("toGmailMessage", () => {
  it("decodes a top-level text/plain body and pulls Subject/From/To headers", () => {
    const resource: GmailMessageResource = {
      id: "msg-1",
      snippet: "hi",
      internalDate: "1700000000000",
      payload: {
        mimeType: "text/plain",
        body: { data: b64url("Hello, this is the body.") },
        headers: [
          { name: "Subject", value: "Welcome" },
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "To", value: "Bob <bob@example.com>" },
        ],
      },
    };

    const message = toGmailMessage(resource);
    expect(message).toEqual({
      id: "msg-1",
      snippet: "hi",
      internalDate: "1700000000000",
      subject: "Welcome",
      from: "Alice <alice@example.com>",
      to: "Bob <bob@example.com>",
      bodyText: "Hello, this is the body.",
    });
  });

  it("finds the text/plain part nested inside a multipart/alternative body", () => {
    const resource: GmailMessageResource = {
      id: "msg-2",
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Plain version.") } },
          { mimeType: "text/html", body: { data: b64url("<p>HTML version.</p>") } },
        ],
      },
    };

    expect(toGmailMessage(resource).bodyText).toBe("Plain version.");
  });

  it("recurses through a multipart/mixed body (attachment alongside a multipart/alternative body)", () => {
    const resource: GmailMessageResource = {
      id: "msg-3",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("Nested plain text.") } },
              { mimeType: "text/html", body: { data: b64url("<p>Nested HTML.</p>") } },
            ],
          },
          { mimeType: "application/pdf", body: { data: b64url("not-really-a-pdf") } },
        ],
      },
    };

    expect(toGmailMessage(resource).bodyText).toBe("Nested plain text.");
  });

  it("correctly base64url-decodes data containing - and _ (not valid in standard base64)", () => {
    // The full byte range 0-255 is guaranteed to hit every 6-bit group a
    // base64 alphabet can produce, including the two positions (62, 63)
    // that base64url spells "-"/"_" instead of standard base64's "+"/"/"
    // — so a decoder that didn't actually handle the URL-safe alphabet
    // would either throw or silently produce wrong bytes on this input.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const encoded = bytes.toString("base64url");
    expect(encoded).toMatch(/-/);
    expect(encoded).toMatch(/_/);

    const resource: GmailMessageResource = {
      id: "msg-4",
      payload: { mimeType: "text/plain", body: { data: encoded } },
    };
    // decodeBase64Url decodes with the same Buffer API this expectation
    // uses, so a byte-for-byte-correct decode round-trips exactly here.
    expect(toGmailMessage(resource).bodyText).toBe(bytes.toString("utf-8"));
  });

  it("returns null bodyText when no text/plain part exists anywhere", () => {
    const resource: GmailMessageResource = {
      id: "msg-5",
      payload: {
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/html", body: { data: b64url("<p>Only HTML.</p>") } }],
      },
    };
    expect(toGmailMessage(resource).bodyText).toBeNull();
  });

  it("returns null bodyText for a message with no payload at all", () => {
    expect(toGmailMessage({ id: "msg-6" }).bodyText).toBeNull();
  });

  it("returns null for missing Subject/From/To headers instead of throwing", () => {
    const resource: GmailMessageResource = { id: "msg-7", payload: { headers: [] } };
    const message = toGmailMessage(resource);
    expect(message.subject).toBeNull();
    expect(message.from).toBeNull();
    expect(message.to).toBeNull();
  });

  it("header lookup is case-insensitive", () => {
    const resource: GmailMessageResource = {
      id: "msg-8",
      payload: { headers: [{ name: "subject", value: "lowercase header name" }] },
    };
    expect(toGmailMessage(resource).subject).toBe("lowercase header name");
  });

  it("defaults a missing snippet to an empty string, not null/undefined", () => {
    expect(toGmailMessage({ id: "msg-9" }).snippet).toBe("");
  });

  it("falls back to roughly now when internalDate is missing", () => {
    const before = Date.now();
    const message = toGmailMessage({ id: "msg-10" });
    const after = Date.now();
    const parsed = Number(message.internalDate);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
