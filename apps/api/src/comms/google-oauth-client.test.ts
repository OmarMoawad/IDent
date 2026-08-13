import { describe, expect, it } from "vitest";
import { RealGoogleOAuthClient } from "./google-oauth-client.js";

// Only getAuthorizationUrl is pure (no network) — exchangeCodeForTokens,
// refreshAccessToken, revokeToken, and getAccountEmail all call Google's
// real endpoints and are exercised indirectly instead, through
// gmail-service.test.ts's FakeGoogleOAuthClient double.
describe("RealGoogleOAuthClient.getAuthorizationUrl", () => {
  it("includes the PKCE code_challenge and S256 method", () => {
    const client = new RealGoogleOAuthClient();
    const url = new URL(client.getAuthorizationUrl("some-state", "some-challenge"));

    expect(url.searchParams.get("code_challenge")).toBe("some-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("includes the state, minimum read-only scopes, and offline+consent for a refresh token", () => {
    const client = new RealGoogleOAuthClient();
    const url = new URL(client.getAuthorizationUrl("some-state", "some-challenge"));

    expect(url.searchParams.get("state")).toBe("some-state");
    // Session 17b added calendar as a second scope on the same Google
    // connection. Asserted as an exact set, not a substring: the point of
    // this test is that the grant stays minimal, so a scope creeping in
    // must fail here rather than pass a loose check.
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    // Both are read-only — the connector must never be able to send,
    // modify, or delete anything.
    expect(url.searchParams.get("scope")).not.toMatch(/\.(send|modify|compose)\b/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("points at Google's real authorization endpoint", () => {
    const client = new RealGoogleOAuthClient();
    const url = new URL(client.getAuthorizationUrl("s", "c"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });
});
