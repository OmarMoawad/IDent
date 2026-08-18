import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ORIGIN } from "./identity/webauthn-config.js";

describe("GET /health", () => {
  it("returns a status consistent with db reachability", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(["ok", "degraded"]).toContain(body.status);
    expect(["ok", "unreachable"]).toContain(body.db);
    expect(body.status).toBe(body.db === "ok" ? "ok" : "degraded");
    expect(typeof body.timestamp).toBe("string");

    await app.close();
  });
});

/**
 * Session 22b, external-review item 1. Two DELETE routes existed
 * (`/identity/reminders/:reminderId`, `/identity/priority-rules/:ruleId`)
 * and neither was reachable from a browser, because the CORS preflight
 * was answered with a method list that omitted DELETE. Nothing caught it:
 * `app.inject()` and curl both bypass CORS entirely, so the route tests
 * passed against routes no browser could call.
 *
 * These assertions are on the *preflight response*, which is the only
 * thing a browser consults before deciding whether to send the real
 * request — so they fail for the same reason a browser would.
 */
async function preflight(method: string) {
  const app = buildApp();
  const response = await app.inject({
    method: "OPTIONS",
    url: "/identity/reminders/00000000-0000-0000-0000-000000000000",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": method,
    },
  });
  await app.close();
  return response;
}

describe("CORS preflight", () => {
  it("allows DELETE, so a browser can delete a reminder or a priority rule", async () => {
    const response = await preflight("DELETE");
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("still allows the methods that already worked", async () => {
    const allowed = (await preflight("GET")).headers["access-control-allow-methods"];
    for (const method of ["GET", "HEAD", "POST", "PUT"]) {
      expect(allowed).toContain(method);
    }
  });

  it("does not answer for an untrusted origin", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/identity/reminders/00000000-0000-0000-0000-000000000000",
      headers: { origin: "https://evil.example", "access-control-request-method": "DELETE" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
