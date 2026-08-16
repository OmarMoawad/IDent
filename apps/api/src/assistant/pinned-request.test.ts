import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { EgressViolationError, postJsonPinned } from "./pinned-request.js";

/**
 * External review finding #6. Session 22 showed the user a sentence about
 * where their data goes; nothing kept the sentence true once the request
 * started. These drive a real local server so the enforcement is exercised
 * over an actual socket rather than asserted about.
 */
let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("a pinned request", () => {
  it("sends the body and returns the response", async () => {
    let received = "";
    const base = await listen((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => (received += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const response = await postJsonPinned(`${base}/chat/completions`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
      allowance: { allowAny: true },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(JSON.parse(received)).toEqual({ hello: "world" });
    // The disclosure can now name the address the socket actually dialled.
    expect(response.pinnedAddress).toBe("127.0.0.1");
    expect(response.assessment.tier).toBe("loopback");
  });

  it("refuses a redirect instead of following it", async () => {
    // The failure the review named: a provider that answers 301 moves the
    // request somewhere the user was never told about, *after* the
    // disclosure was composed. fetch would have followed this silently.
    const base = await listen((_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/chat/completions" });
      res.end();
    });

    await expect(
      postJsonPinned(`${base}/chat/completions`, {
        headers: { "content-type": "application/json" },
        body: "{}",
        allowance: { allowAny: true },
      }),
    ).rejects.toThrow(EgressViolationError);
  });

  it("refuses a destination the caller does not allow, before sending anything", async () => {
    let reached = false;
    const base = await listen((_req, res) => {
      reached = true;
      res.writeHead(200).end("{}");
    });

    await expect(
      postJsonPinned(`${base}/chat/completions`, {
        headers: {},
        body: "{}",
        // A deployment that promises local-only processing would say this.
        allowance: { allow: ["same_process"] },
      }),
    ).rejects.toThrow(/Refusing to send data to a loopback destination/);

    // The point of checking before connecting: the data never left.
    expect(reached).toBe(false);
  });

  it("reports the tier on the violation, so the caller can say what happened", async () => {
    const base = await listen((_req, res) => res.writeHead(200).end("{}"));

    const error = await postJsonPinned(`${base}/x`, {
      headers: {},
      body: "{}",
      allowance: { allow: ["public_internet"] },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EgressViolationError);
    expect((error as EgressViolationError).assessment.tier).toBe("loopback");
  });

  it("surfaces a non-2xx status rather than throwing it away", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model loading" }));
    });

    const response = await postJsonPinned(`${base}/x`, {
      headers: {},
      body: "{}",
      allowance: { allowAny: true },
    });
    expect(response.status).toBe(503);
  });
});
