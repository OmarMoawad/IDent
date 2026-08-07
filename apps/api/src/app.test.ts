import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

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
