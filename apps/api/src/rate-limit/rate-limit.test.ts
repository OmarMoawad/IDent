import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { pool } from "../db/pool.js";
import { isRateLimitEnforced, policiesForRoute, RATE_LIMIT_POLICIES } from "./policy.js";
import { countRequest, pruneExpiredCounters } from "./store.js";

/**
 * Enforcement is off in the test environment by default (see policy.ts for
 * why), so this file switches it on for itself. Every case uses a subject
 * nothing else shares — a fresh bucket name or a unique remote address —
 * because the whole suite runs against one Postgres in parallel workers,
 * and a limiter test that leaks into a neighbouring file is exactly the
 * kind of load-shaped flake this repo has already misdiagnosed twice.
 */
beforeAll(() => {
  process.env.RATE_LIMIT_ENFORCE = "1";
});

afterAll(() => {
  delete process.env.RATE_LIMIT_ENFORCE;
});

function uniqueBucket(): string {
  return `test-${randomUUID()}`;
}

describe("the counter itself", () => {
  it("allows exactly `limit` requests, then refuses", async () => {
    const policy = { bucket: uniqueBucket(), subject: "ip" as const, limit: 3, windowSeconds: 60 };
    const verdicts = [];
    for (let i = 0; i < 4; i++) verdicts.push(await countRequest(policy, "subject-a"));

    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false]);
    expect(verdicts.map((v) => v.count)).toEqual([1, 2, 3, 4]);
  });

  it("keeps subjects independent, so one caller cannot throttle another", async () => {
    const policy = { bucket: uniqueBucket(), subject: "ip" as const, limit: 1, windowSeconds: 60 };
    expect((await countRequest(policy, "caller-1")).allowed).toBe(true);
    expect((await countRequest(policy, "caller-1")).allowed).toBe(false);
    expect((await countRequest(policy, "caller-2")).allowed).toBe(true);
  });

  it("starts a new window once the old one has expired", async () => {
    const bucket = uniqueBucket();
    const policy = { bucket, subject: "ip" as const, limit: 1, windowSeconds: 60 };

    expect((await countRequest(policy, "subject")).allowed).toBe(true);
    expect((await countRequest(policy, "subject")).allowed).toBe(false);

    // Age the window rather than sleeping through it.
    await pool.query(
      `UPDATE rate_limit_counters SET window_start = now() - interval '61 seconds'
       WHERE bucket = $1 AND subject = $2`,
      [bucket, "subject"],
    );

    const afterReset = await countRequest(policy, "subject");
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.count).toBe(1);
  });

  it("does not let a refused request push the window further out", async () => {
    const bucket = uniqueBucket();
    const policy = { bucket, subject: "ip" as const, limit: 1, windowSeconds: 60 };
    await countRequest(policy, "subject");
    const first = await countRequest(policy, "subject");
    const second = await countRequest(policy, "subject");

    // Both refusals sit in the same window, so the wait shrinks with time
    // rather than resetting on every attempt.
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
  });

  it("counts concurrent requests exactly once each — the flood case", async () => {
    const policy = { bucket: uniqueBucket(), subject: "ip" as const, limit: 5, windowSeconds: 60 };
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => countRequest(policy, "concurrent")));

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(new Set(verdicts.map((v) => v.count)).size).toBe(20);
  });

  it("never advertises a zero-second Retry-After", async () => {
    const policy = { bucket: uniqueBucket(), subject: "ip" as const, limit: 0, windowSeconds: 1 };
    expect((await countRequest(policy, "subject")).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("prune", () => {
  it("deletes counters whose window ended long ago, and keeps live ones", async () => {
    const stale = uniqueBucket();
    const live = uniqueBucket();
    await countRequest({ bucket: stale, subject: "ip", limit: 1, windowSeconds: 60 }, "s");
    await countRequest({ bucket: live, subject: "ip", limit: 1, windowSeconds: 60 }, "s");
    await pool.query(`UPDATE rate_limit_counters SET window_start = now() - interval '3 days' WHERE bucket = $1`, [
      stale,
    ]);

    await pruneExpiredCounters(24 * 60 * 60);

    const remaining = await pool.query(`SELECT bucket FROM rate_limit_counters WHERE bucket = ANY($1)`, [
      [stale, live],
    ]);
    expect(remaining.rows.map((r) => r.bucket)).toEqual([live]);
  });
});

describe("route policy", () => {
  it("throttles login by IP and by username", () => {
    expect(policiesForRoute("POST", "/identity/login").map((p) => p.bucket)).toEqual([
      "auth-login-ip",
      "auth-login-username",
    ]);
  });

  it("gives an unlisted route a default rather than nothing", () => {
    expect(policiesForRoute("POST", "/identity/some/route/added/later")[0]).toBe(
      RATE_LIMIT_POLICIES["default-write"],
    );
    expect(policiesForRoute("GET", "/identity/some/route/added/later")[0]).toBe(RATE_LIMIT_POLICIES["default-read"]);
  });

  it("exempts /health, so an uptime probe cannot report an outage that is not happening", () => {
    expect(policiesForRoute("GET", "/health")).toEqual([]);
  });

  it("is enforced outside the test environment, and off inside it by default", () => {
    expect(isRateLimitEnforced({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRateLimitEnforced({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRateLimitEnforced({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isRateLimitEnforced({ NODE_ENV: "test", RATE_LIMIT_ENFORCE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

/**
 * The end-to-end half: these drive the real routes through the real hook,
 * so they fail if the hook stops being registered — which is the failure
 * the review actually found (nothing was limited anywhere).
 */
describe("over HTTP", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  function ip(): string {
    // Distinct per test: a shared loopback address would make these
    // throttle each other instead of what they mean to measure.
    return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  }

  it("answers 429 with Retry-After once login attempts from one IP run out", async () => {
    const remoteAddress = ip();
    const limit = RATE_LIMIT_POLICIES["auth-login-ip"].limit;
    let last;
    for (let i = 0; i <= limit; i++) {
      last = await app.inject({
        method: "POST",
        url: "/identity/login",
        remoteAddress,
        // A different username each time, so the per-username limit is
        // never the one that fires here.
        payload: { username: `nobody-${randomUUID()}`, password: "wrong password" },
      });
    }

    expect(last?.statusCode).toBe(429);
    expect(Number(last?.headers["retry-after"])).toBeGreaterThan(0);
    // The refusal says nothing about which limit was hit or whether the
    // account exists.
    expect(last?.json()).toEqual({ error: "Too many requests. Try again later." });
    /**
     * The very generous timeout is the finding, not an inconvenience: 21
     * failed logins take **tens of seconds** of real CPU here, because
     * argon2 runs even for a username that does not exist (deliberately —
     * otherwise the response time itself would say whether an account
     * exists). Measured on this machine under a full parallel run: over
     * 30 seconds, which is why this number is 60 and not 30.
     *
     * Read that again as an attacker would. Twenty-one requests, costing
     * the sender nothing, cost the server half a minute of CPU. That is
     * exactly the exhaustion vector the review named, and this test is
     * what now bounds it.
     */
  }, 60_000);

  it("throttles one username across many IPs — the credential-stuffing shape", async () => {
    const username = `target-${randomUUID()}`;
    const limit = RATE_LIMIT_POLICIES["auth-login-username"].limit;
    let last;
    for (let i = 0; i <= limit; i++) {
      last = await app.inject({
        method: "POST",
        url: "/identity/login",
        remoteAddress: ip(), // a fresh address every attempt
        payload: { username, password: "wrong password" },
      });
    }

    expect(last?.statusCode).toBe(429);
    // Same argon2 cost as the per-IP case above, so the same generous
    // timeout: nine failed logins is seconds of real CPU, and under a
    // full parallel run this exceeded vitest's 5s default and failed
    // while passing in isolation — which is the exact shape of flake this
    // repo has already misdiagnosed twice.
  }, 30_000);

  it("leaves /health alone however often it is polled", async () => {
    const remoteAddress = ip();
    for (let i = 0; i < 50; i++) {
      const response = await app.inject({ method: "GET", url: "/health", remoteAddress });
      expect(response.statusCode).toBe(200);
    }
  });

  it("counts an ingest flood against the token, not the sender's address", async () => {
    const token = `fake-token-${randomUUID()}`;
    const limit = RATE_LIMIT_POLICIES["notification-ingest"].limit;
    let last;
    for (let i = 0; i <= limit; i++) {
      last = await app.inject({
        method: "POST",
        url: "/notifications/ingest",
        remoteAddress: ip(), // a fresh address every attempt
        headers: { "x-ident-notification-token": token },
        payload: { app: "test", title: "hello" },
      });
    }

    expect(last?.statusCode).toBe(429);
  });

  it("stores a hash of the ingest token as the subject, never the token", async () => {
    const token = `secret-token-${randomUUID()}`;
    await app.inject({
      method: "POST",
      url: "/notifications/ingest",
      headers: { "x-ident-notification-token": token },
      payload: { app: "test", title: "hello" },
    });

    const { rows } = await pool.query(`SELECT subject FROM rate_limit_counters WHERE subject LIKE '%' || $1 || '%'`, [
      token,
    ]);
    expect(rows).toHaveLength(0);
  });
});
