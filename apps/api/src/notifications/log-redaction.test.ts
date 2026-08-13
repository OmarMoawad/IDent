import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

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
