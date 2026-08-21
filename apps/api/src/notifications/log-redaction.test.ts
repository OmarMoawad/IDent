import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp, redactSensitiveUrl } from "../app.js";

/**
 * The finding this file exists for: the ingest token can travel as a URL
 * path segment, and Fastify logs `req.url` on every request. Without a
 * serializer that scrubs it, the credential is written into application
 * logs and onward into any proxy, tracing, or analytics system.
 *
 * Asserted against real captured log output rather than by reading the
 * serializer — the question is what actually reaches the log stream.
 */
function captureLogs(): { lines: string[]; stream: { write(chunk: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (chunk: string) => void lines.push(chunk) } };
}

describe("ingest token is never written to the request log", () => {
  it("redacts the token from the URL Fastify logs", async () => {
    const captured = captureLogs();
    const app = buildApp({ loggerStream: captured.stream });
    const token = `tok-${randomUUID()}`;

    await app.inject({ method: "POST", url: `/notifications/ingest/${token}`, payload: { app: "X", title: "Y" } });
    await app.close();

    const output = captured.lines.join("\n");
    expect(output).toContain("/notifications/ingest/[redacted]");
    // The whole point: the credential itself must appear nowhere.
    expect(output).not.toContain(token);
  });

  it("leaves ordinary URLs untouched", async () => {
    const captured = captureLogs();
    const app = buildApp({ loggerStream: captured.stream });
    await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(captured.lines.join("\n")).toContain("/health");
  });
});

describe("OAuth credentials are never written to the request log", () => {
  it("redacts the callback query string while retaining the route", async () => {
    const captured = captureLogs();
    const app = buildApp({ loggerStream: captured.stream });
    const code = `code-${randomUUID()}`;
    const state = `state-${randomUUID()}`;

    await app.inject({
      method: "GET",
      url: `/identity/connections/gmail/callback?code=${code}&state=${state}`,
    });
    await app.close();

    const output = captured.lines.join("\n");
    expect(output).toContain("/identity/connections/gmail/callback?[redacted]");
    expect(output).not.toContain(code);
    expect(output).not.toContain(state);
  });
});

/**
 * The regression that motivated generalising the pattern. The first fix
 * was anchored to the literal `gmail` path, which was correct for the
 * only callback that existed and silently wrong for the next one — and
 * the connector abstraction exists precisely so that there will be a
 * next one. These assert the shape of the rule, not one provider's
 * spelling of it.
 */
describe("callback redaction covers any provider, not just the first one", () => {
  it("redacts a provider that does not exist yet", () => {
    const redacted = redactSensitiveUrl(
      "/identity/connections/outlook/callback?code=secret-code&state=secret-state",
    );

    expect(redacted).toBe("/identity/connections/outlook/callback?[redacted]");
    expect(redacted).not.toContain("secret-code");
    expect(redacted).not.toContain("secret-state");
  });

  it("keeps the provider's own error diagnosis, which is the useful half", () => {
    const redacted = redactSensitiveUrl(
      "/identity/connections/gmail/callback?error=access_denied&code=secret-code",
    );

    expect(redacted).toContain("error=access_denied");
    expect(redacted).not.toContain("secret-code");
  });

  it("keeps error_description, the message that named the disabled API", () => {
    const redacted = redactSensitiveUrl(
      "/identity/connections/gmail/callback?error=invalid_request&error_description=Gmail+API+has+not+been+used&state=secret-state",
    );

    expect(redacted).toContain("error_description=Gmail+API+has+not+been+used");
    expect(redacted).not.toContain("secret-state");
  });

  it("leaves a URL that is not a callback alone", () => {
    expect(redactSensitiveUrl("/identity/connections?cursor=abc")).toBe(
      "/identity/connections?cursor=abc",
    );
    expect(redactSensitiveUrl("/health")).toBe("/health");
  });

  it("redacts a callback whose query carries nothing loggable", () => {
    expect(redactSensitiveUrl("/identity/connections/gmail/callback?code=abc")).toBe(
      "/identity/connections/gmail/callback?[redacted]",
    );
  });
});

describe("a second provider's callback is redacted in real log output", () => {
  it("never writes another connector's code or state to the stream", async () => {
    const captured = captureLogs();
    const app = buildApp({ loggerStream: captured.stream });
    const code = `code-${randomUUID()}`;
    const state = `state-${randomUUID()}`;

    // No such route is registered, so this is a 404 — and a 404 is still
    // logged, which is the point: the redaction has to happen at the
    // serializer, before routing decides anything.
    await app.inject({
      method: "GET",
      url: `/identity/connections/calendar/callback?code=${code}&state=${state}`,
    });
    await app.close();

    const output = captured.lines.join("\n");
    expect(output).toContain("/identity/connections/calendar/callback?[redacted]");
    expect(output).not.toContain(code);
    expect(output).not.toContain(state);
  });
});

describe("the not-found response body is redacted too", () => {
  it("does not echo an authorization code back to the browser", async () => {
    const app = buildApp();
    const code = `code-${randomUUID()}`;

    const response = await app.inject({
      method: "GET",
      url: `/identity/connections/outlook/callback?code=${code}`,
    });
    await app.close();

    // A provider's redirect lands in a real browser, so the 404 body is
    // rendered on screen and lives in history — not only in the log.
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(code);
    expect(response.body).toContain("[redacted]");
  });

  it("redacts an ingest token that reaches an unrouted path", async () => {
    const app = buildApp();
    const token = `tok-${randomUUID()}`;

    const response = await app.inject({ method: "GET", url: `/notifications/ingest/${token}` });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(token);
  });
});
